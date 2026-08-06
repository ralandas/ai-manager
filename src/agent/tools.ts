import { config } from '../config.js';
import type { Messenger } from '../messenger/types.js';
import type { PmsConnector } from '../pms/types.js';
import type { ToolSchema } from '../llm/types.js';
import { apartmentPageUrl } from '../frontend/routes.js';
import { listPhotoUrls } from '../frontend/photos.js';
import {
  listOwnerApartments,
  getApartmentCard,
  type AptCard,
} from '../store/apartments-repo.js';
import {
  rememberBookingContact,
  setCheckoutTime,
  allBookingContacts,
} from '../store/booking-contacts.js';
import {
  assertAutonomyEnabled,
  audit,
  bookingIdempotencyKey,
  validateBooking,
} from '../safety.js';

/** Mutable per-chat scratch state that survives across tools within a turn. */
export interface AgentSession {
  /** Booking created in this conversation, if any. */
  lastBookingId?: string;
}

/**
 * Builds the tool set for a specific chat. The chatId is closed over so tools
 * can key idempotency and notify the owner without the model passing it around.
 * The session lets get_payment_link fall back to the booking we just created,
 * instead of relying on the model to remember the id.
 */
export function buildTools(deps: {
  pms: PmsConnector;
  messenger: Messenger;
  chatId: string;
  session: AgentSession;
}): ToolSchema[] {
  const { pms, messenger, chatId, session } = deps;

  const notifyOwner = async (text: string) => {
    if (config.OWNER_CHAT_ID) {
      await messenger.sendMessage(config.OWNER_CHAT_ID, text).catch(() => {});
    }
  };

  const ownerId = config.AGENT_OWNER_ID;

  // Two owner modes:
  //  - DB mode (e.g. RealtyCalendar pilot): apartments are curated cards in our
  //    DB, each linked to an rc_apartment_id; the model uses OUR card ids.
  //  - Direct-PMS mode (e.g. Bnovo): the PMS itself is the source of truth for
  //    the apartment list; there are no DB cards. We pass propertyIds straight
  //    through to the connector.
  // We detect direct mode lazily: an owner with zero DB apartments is direct.
  let directPmsCache: boolean | null = null;
  const isDirectPms = async (): Promise<boolean> => {
    if (!ownerId) return true; // no owner → legacy passthrough (already direct)
    if (directPmsCache === null) {
      directPmsCache = (await listOwnerApartments(ownerId)).length === 0;
    }
    return directPmsCache;
  };

  // Load a card by our id (DB mode) — used to resolve rc id + info + price.
  const card = async (id: string): Promise<AptCard | null> =>
    ownerId && !(await isDirectPms()) ? getApartmentCard(ownerId, id) : null;

  // Map the propertyId the model uses to the PMS id for connector calls.
  // DB mode: our card id → rc_apartment_id. Direct mode / no owner: pass through.
  const toRcId = async (propertyId: string): Promise<string | null> => {
    if (!ownerId || (await isDirectPms())) return propertyId;
    const c = await getApartmentCard(ownerId, propertyId);
    return c?.rcApartmentId ?? null;
  };

  return [
    {
      name: 'list_properties',
      description: 'Список доступных квартир с ценами.',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        if (ownerId && !(await isDirectPms())) {
          const cards = await listOwnerApartments(ownerId);
          return cards.map((c) => ({ id: c.id, title: c.title, price: c.price }));
        }
        // Direct-PMS (Bnovo) or legacy: the connector is the source of truth.
        const props = await pms.listProperties();
        return props.map((p) => ({ id: p.id, title: p.title, price: p.basePrice }));
      },
    },
    {
      name: 'check_availability',
      description:
        'Проверить доступность и рассчитать стоимость на даты. Даты в формате YYYY-MM-DD, checkOut — день выезда (не входит в оплату).',
      parameters: {
        type: 'object',
        properties: {
          propertyId: { type: 'string', description: 'ID квартиры; опустить — проверить все' },
          checkIn: { type: 'string', description: 'Дата заезда YYYY-MM-DD' },
          checkOut: { type: 'string', description: 'Дата выезда YYYY-MM-DD' },
          guests: { type: 'integer', description: 'Число гостей' },
        },
        required: ['checkIn', 'checkOut', 'guests'],
      },
      handler: async (a) => {
        const checkIn = a.checkIn as string;
        const checkOut = a.checkOut as string;
        const guests = Number(a.guests);

        if (!ownerId || (await isDirectPms())) {
          // Direct-PMS (Bnovo) / legacy: ask the connector for the whole fund.
          return pms.checkAvailability({
            propertyId: a.propertyId as string | undefined,
            checkIn,
            checkOut,
            guests,
          });
        }

        // DB mode: build the list of cards to check, resolve each to its RC id.
        const cards = a.propertyId
          ? ([await card(a.propertyId as string)].filter(Boolean) as AptCard[])
          : await listOwnerApartments(ownerId);

        const results = [];
        for (const c of cards) {
          if (!c.rcApartmentId) {
            // No RC link yet — report as not bookable via RC.
            results.push({
              propertyId: c.id,
              title: c.title,
              available: false,
              note: 'бронирование этой квартиры пока не настроено',
            });
            continue;
          }
          const rc = await pms.checkAvailability({
            propertyId: c.rcApartmentId,
            checkIn,
            checkOut,
            guests,
          });
          const r = rc[0];
          results.push({
            propertyId: c.id, // keep OUR id so downstream tools resolve correctly
            title: c.title,
            available: r?.available ?? false,
            nights: r?.nights,
            totalPrice: r?.totalPrice ?? (c.price ?? 0),
          });
        }
        return results;
      },
    },
    {
      name: 'create_booking',
      description:
        'Создать бронирование после подтверждения деталей клиентом. Возвращает бронь. Сумму бери из check_availability.',
      parameters: {
        type: 'object',
        properties: {
          propertyId: { type: 'string' },
          checkIn: { type: 'string', description: 'YYYY-MM-DD' },
          checkOut: { type: 'string', description: 'YYYY-MM-DD' },
          guests: { type: 'integer' },
          guestName: { type: 'string', description: 'Имя гостя' },
          guestPhone: { type: 'string' },
          totalPrice: { type: 'integer', description: 'Итоговая сумма из check_availability' },
        },
        required: ['propertyId', 'checkIn', 'checkOut', 'guests', 'guestName', 'totalPrice'],
      },
      handler: async (a) => {
        assertAutonomyEnabled();
        const input = {
          checkIn: a.checkIn as string,
          checkOut: a.checkOut as string,
          guests: Number(a.guests),
          totalPrice: Number(a.totalPrice),
        };
        validateBooking(input);
        const cardId = a.propertyId as string;
        const rcId = await toRcId(cardId);
        if (!rcId) {
          return { error: 'Для этой квартиры не настроено бронирование (нет связи с PMS)' };
        }
        const key = bookingIdempotencyKey({
          chatId,
          propertyId: cardId,
          checkIn: input.checkIn,
          checkOut: input.checkOut,
        });
        let booking;
        try {
          booking = await pms.createBooking({
            propertyId: rcId,
            guestName: a.guestName as string,
            guestPhone: a.guestPhone as string | undefined,
            idempotencyKey: key,
            ...input,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Overbooking guard (or PMS refusal): tell the model plainly so it
          // offers other dates/apartments instead of retrying the same slot.
          if (/refused|already booked|occupied|занят/i.test(msg)) {
            return {
              error: 'Эти даты на выбранной квартире уже заняты. Предложи гостю другие даты или другую квартиру — НЕ создавай бронь на занятые даты.',
            };
          }
          return { error: `Не удалось создать бронь: ${msg}` };
        }
        session.lastBookingId = booking.id;
        // Link the booking to this chat so we can DM the guest before checkout.
        rememberBookingContact({
          bookingId: booking.id,
          chatId,
          guestName: booking.guestName,
          propertyId: booking.propertyId,
          checkOut: booking.checkOut,
          createdAt: Date.now(),
        });
        audit('create_booking', { chatId, bookingId: booking.id, ...input });
        await notifyOwner(
          `🆕 Бронь ${booking.id}: ${booking.propertyId}, ${booking.checkIn}→${booking.checkOut}, ${booking.guests} гост., ${booking.totalPrice}. Гость: ${booking.guestName}`,
        );
        return booking;
      },
    },
    {
      name: 'get_payment_link',
      description:
        'Получить ссылку на оплату по созданной брони и отдать её клиенту. Если bookingId не указан, берётся бронь этого диалога.',
      parameters: {
        type: 'object',
        properties: {
          bookingId: { type: 'string', description: 'ID брони; можно опустить для брони этого диалога' },
        },
        required: [],
      },
      handler: async (a) => {
        assertAutonomyEnabled();
        const bookingId = (a.bookingId as string | undefined) ?? session.lastBookingId;
        if (!bookingId) return { error: 'В этом диалоге ещё нет созданной брони' };
        const link = await pms.getPaymentLink(bookingId);
        audit('get_payment_link', { chatId, bookingId, url: link.url });
        return link;
      },
    },
    {
      name: 'check_payment',
      description:
        'Проверить, оплатил ли гость бронь (внесён ли платёж по счёту). Если bookingId не указан — берётся бронь этого диалога. Вызывай, когда гость говорит «оплатил»/«скинул», чтобы подтвердить.',
      parameters: {
        type: 'object',
        properties: {
          bookingId: { type: 'string', description: 'ID брони; можно опустить для брони этого диалога' },
        },
        required: [],
      },
      handler: async (a) => {
        const bookingId = (a.bookingId as string | undefined) ?? session.lastBookingId;
        if (!bookingId) return { error: 'В этом диалоге ещё нет созданной брони' };
        if (!pms.isBookingPaid) return { error: 'Проверка оплаты недоступна для этого объекта' };
        const paid = await pms.isBookingPaid(bookingId);
        audit('check_payment', { chatId, bookingId, paid });
        return { bookingId, paid };
      },
    },
    {
      name: 'get_apartment_info',
      description:
        'Ссылка на страницу квартиры с правилами проживания и инструкцией по заселению. Дай её клиенту вместо пересказа правил текстом.',
      parameters: {
        type: 'object',
        properties: {
          propertyId: { type: 'string', description: 'ID квартиры (из check_availability)' },
        },
        required: ['propertyId'],
      },
      handler: async (a) => {
        const id = a.propertyId as string;
        const c = await card(id);
        if (!c) return { error: 'Квартира не найдена' };
        return { url: apartmentPageUrl(id), title: c.title };
      },
    },
    {
      name: 'send_apartment_photos',
      description:
        'Отправить клиенту фото квартир с подписью (адрес + цена). Передай propertyId (одна квартира) ИЛИ propertyIds (несколько — например все показанные варианты). ID бери из check_availability/list_properties. НЕ говори, что фото нет, не вызвав этот инструмент.',
      parameters: {
        type: 'object',
        properties: {
          propertyId: { type: 'string', description: 'ID одной квартиры' },
          propertyIds: {
            type: 'string',
            description: 'Несколько ID через запятую — отправить фото по каждой квартире',
          },
        },
        required: [],
      },
      handler: async (a) => {
        if (!messenger.sendPhotos) return { error: 'Отправка фото недоступна в этом канале' };
        // Accept one id or a comma-separated list; cap the fan-out.
        const ids = [
          ...(a.propertyId ? [String(a.propertyId)] : []),
          ...(a.propertyIds ? String(a.propertyIds).split(',').map((s) => s.trim()) : []),
        ].filter(Boolean);
        if (ids.length === 0) return { error: 'Укажи propertyId или propertyIds' };

        // Keep the volume modest — fresh Telegram accounts have tight media
        // limits. Fewer photos per apartment + fewer apartments per request
        // keeps us well under FloodWait; the messenger queue spaces them out.
        const MAX_APTS = 3;
        const MAX_PER_APT = 5;
        const titles = new Map((await pms.listProperties()).map((p) => [p.id, p.title]));

        const results: Array<{ propertyId: string; sent: number }> = [];
        const empty: string[] = [];
        const chosen = ids.slice(0, MAX_APTS);
        for (let i = 0; i < chosen.length; i++) {
          const id = chosen[i]!;
          // 1) local photos (admin upload), 2) fallback — PMS photos.
          let urls = listPhotoUrls(id);
          if (urls.length === 0 && pms.getPhotos) {
            const rcId = await toRcId(id);
            if (rcId) {
              try {
                urls = await pms.getPhotos(rcId);
              } catch {
                /* ignore */
              }
            }
          }
          if (urls.length === 0) {
            empty.push(titles.get(id) ?? id);
            continue;
          }
          const c = await card(id);
          const caption = c
            ? `${c.title}${c.price ? ` — ${c.price} ₽/ночь` : ''}`
            : titles.get(id);
          await messenger.sendPhotos(chatId, urls.slice(0, MAX_PER_APT), caption);
          audit('send_apartment_photos', { chatId, propertyId: id, count: Math.min(urls.length, MAX_PER_APT) });
          results.push({ propertyId: id, sent: Math.min(urls.length, MAX_PER_APT) });
        }

        if (results.length === 0) {
          return { error: `Фото не найдены для: ${empty.join(', ') || ids.join(', ')}` };
        }
        return { ok: true, sent: results, noPhotos: empty };
      },
    },
    {
      name: 'confirm_checkout_time',
      description:
        'Записать подтверждённое гостем время выезда (когда гость ответил на напоминание о выезде). Время в формате ЧЧ:ММ.',
      parameters: {
        type: 'object',
        properties: {
          time: { type: 'string', description: 'Время выезда ЧЧ:ММ, например 11:30' },
        },
        required: ['time'],
      },
      handler: async (a) => {
        const time = a.time as string;
        // Find this chat's most recent booking to attach the time to.
        const mine = allBookingContacts()
          .filter((c) => c.chatId === chatId)
          .sort((x, y) => (x.checkOut < y.checkOut ? 1 : -1));
        const target = mine[0];
        if (!target) return { error: 'Не нашёл вашу бронь, чтобы записать время выезда' };
        setCheckoutTime(target.bookingId, time);
        audit('confirm_checkout_time', { chatId, bookingId: target.bookingId, time });
        await notifyOwner(
          `⏰ Гость подтвердил выезд ${target.checkOut} в ${time} — ${target.guestName} (${target.propertyId})`,
        );
        return { ok: true, bookingId: target.bookingId, time };
      },
    },
  ];
}
