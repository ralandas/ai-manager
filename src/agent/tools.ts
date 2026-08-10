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
  getBookingContact,
  isPaymentWindowDead,
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

  // Payment hold window (must match the watcher): past this, an unpaid booking's
  // invoice link is dead even if the watcher never got to flag it `cancelled`.
  const cancelMs = config.PAYMENT_CANCEL_MS ?? 30 * 60 * 1000;

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
        'Проверить доступность и стоимость на даты. Даты YYYY-MM-DD, checkOut — день выезда. Если свободных много, можно сузить: area (район/улица, напр. "Невский", "Василеостровский") и/или maxPrice/minPrice (бюджет за весь период). Ответ содержит total (сколько всего свободно) и results (после фильтра).',
      parameters: {
        type: 'object',
        properties: {
          propertyId: { type: 'string', description: 'ID квартиры; опустить — проверить все' },
          checkIn: { type: 'string', description: 'Дата заезда YYYY-MM-DD' },
          checkOut: { type: 'string', description: 'Дата выезда YYYY-MM-DD' },
          guests: { type: 'integer', description: 'Число гостей' },
          area: { type: 'string', description: 'Фильтр по району/улице (подстрока адреса)' },
          maxPrice: { type: 'integer', description: 'Не дороже этой суммы за весь период' },
          minPrice: { type: 'integer', description: 'Не дешевле этой суммы за весь период' },
        },
        required: ['checkIn', 'checkOut', 'guests'],
      },
      handler: async (a) => {
        const checkIn = a.checkIn as string;
        const checkOut = a.checkOut as string;
        const guests = Number(a.guests);
        const area = a.area ? String(a.area).toLowerCase() : undefined;
        const maxPrice = a.maxPrice ? Number(a.maxPrice) : undefined;
        const minPrice = a.minPrice ? Number(a.minPrice) : undefined;

        // Token match for area/address: "гороховая 79" must match title
        // "Гороховая улица 79" — a plain substring check fails on the "улица".
        const areaTokens = area
          ? area.replace(/[^a-zа-я0-9\s]/gi, ' ').split(/\s+/).filter((t) => t.length >= 2 && !['улица', 'проспект', 'переулок', 'дом', 'канала', 'набережная', 'остров', 'острова'].includes(t))
          : [];
        const matchesArea = (title: string) => {
          if (areaTokens.length === 0) return true;
          const tt = new Set(title.toLowerCase().replace(/[^a-zа-я0-9\s]/gi, ' ').split(/\s+/));
          return areaTokens.every((t) => tt.has(t));
        };
        const applyFilters = (
          rows: Array<{
            title: string;
            available: boolean;
            nights?: number;
            totalPrice?: number;
            capacity?: number;
            minStay?: number;
          }>,
        ) => {
          const nights = rows[0]?.nights;
          const availableRows = rows.filter((r) => r.available);
          const total = availableRows.length;
          let results = availableRows;
          // Capacity: never offer a room that can't sleep the party. Bnovo gives
          // us the bed count; a room with a known, smaller capacity is dropped.
          // When the party exceeds a room's capacity Bnovo drops it from the
          // tariff response entirely, so price AND capacity come back empty
          // together — that pair means "doesn't fit", not "unknown". Treating it
          // as unknown used to keep the room in results with no price, and the
          // model then looped forever on «уточню стоимость» (it had a room to
          // offer but never a number). A missing capacity WITH a price is a
          // genuine unknown and still passes.
          const doesNotFit = (r: { totalPrice?: number; capacity?: number }) =>
            (r.capacity != null && r.capacity < guests) ||
            (r.capacity == null && r.totalPrice == null);
          const tooSmall = guests > 0 ? availableRows.filter(doesNotFit) : [];
          if (guests > 0) results = results.filter((r) => !doesNotFit(r));
          if (area) results = results.filter((r) => matchesArea(r.title));
          if (maxPrice != null) results = results.filter((r) => r.totalPrice != null && r.totalPrice <= maxPrice);
          if (minPrice != null) results = results.filter((r) => r.totalPrice != null && r.totalPrice >= minPrice);
          // Min-stay: flag rooms whose owner set a longer minimum than requested,
          // so the model can say "на эти даты минимум N ночей" instead of booking.
          const nightsReq = typeof nights === 'number' ? nights : undefined;
          const minStayBlocked = nightsReq != null
            ? [...new Set(results.filter((r) => r.minStay && r.minStay > nightsReq).map((r) => `${r.title} (мин. ${r.minStay} ноч.)`))]
            : [];
          if (nightsReq != null) results = results.filter((r) => !r.minStay || r.minStay <= nightsReq);
          // When the guest named a specific address, tell apart "занято" from
          // "нет такой": list matching rooms that exist but are busy on the dates.
          const busyAtArea = area
            ? [...new Set(rows.filter((r) => !r.available && matchesArea(r.title)).map((r) => r.title))]
            : [];
          const existsAtArea = area
            ? [...new Set(rows.filter((r) => matchesArea(r.title)).map((r) => r.title))]
            : [];
          // A ready-made instruction for the model so it can't misread "занято"
          // as "нет такой" (deepseek sometimes does).
          let note: string | undefined;
          if (area) {
            if (results.length > 0) note = `«${area}» свободна на эти даты — назови цену из results.`;
            else if (busyAtArea.length > 0) note = `«${busyAtArea.join(', ')}» ЗАНЯТА на эти даты. Скажи гостю, что занята, и предложи другие даты/варианты. НЕ говори, что такой квартиры нет.`;
            else if (existsAtArea.length === 0) note = `Квартиры по запросу «${area}» в базе нет — предложи похожие из общего списка.`;
          }
          // Capacity note takes priority when the party doesn't fit anywhere shown.
          if (tooSmall.length > 0 && results.length === 0 && guests > 0) {
            // Named address that exists and is free but is simply too small:
            // say so outright. Otherwise the empty-results branch above would
            // claim «такой квартиры нет», which is wrong and confusing.
            const namedTooSmall = area
              ? [...new Set(tooSmall.filter((r) => matchesArea(r.title)).map((r) => r.title))]
              : [];
            note = namedTooSmall.length > 0
              ? `«${namedTooSmall.join(', ')}» НЕ вмещает ${guests} гостей (это точный ответ PMS, не «неизвестно»). Прямо скажи гостю, что на ${guests} гостей эта квартира не подходит, и предложи другую квартиру или меньше гостей. НЕ обещай «уточнить стоимость» — цены на такое размещение не существует, и повторный вызов инструмента ничего не изменит.`
              : `Нет вариантов, вмещающих ${guests} гостей на эти даты. НЕ предлагай меньшие по вместимости квартиры. Предложи другие даты или скажи, что подходящего нет.`;
          } else if (minStayBlocked.length > 0 && results.length === 0) {
            note = `На эти даты действует ограничение минимального срока: ${minStayBlocked.join(', ')}. Предложи гостю бронировать на нужное число ночей или другие даты.`;
          }
          return { total, filtered: results.length, results, busyAtArea, minStayBlocked, note };
        };

        if (!ownerId || (await isDirectPms())) {
          // Direct-PMS (Bnovo) / legacy: ask the connector for the whole fund.
          const rows = await pms.checkAvailability({
            propertyId: a.propertyId as string | undefined,
            checkIn,
            checkOut,
            guests,
          });
          if (a.propertyId) return rows; // specific room — return as-is
          return applyFilters(rows);
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
          // Capacity refusal: room can't sleep the party. Don't downsell.
          if (/sleeps \d+, but/i.test(msg)) {
            return {
              error: 'Эта квартира не вмещает столько гостей. Предложи вариант побольше — НЕ бронируй меньшую по вместимости.',
            };
          }
          // Stay-length / arrival refusal: owner's min/max-nights or closed arrival.
          const minStayM = msg.match(/minimum stay for \S+ is (\d+) nights/i);
          if (minStayM) {
            return {
              error: `На эти даты минимальный срок брони — ${minStayM[1]} ноч. Предложи гостю забронировать минимум на ${minStayM[1]} ноч. или выбрать другие даты. НЕ бронируй на меньший срок.`,
            };
          }
          const maxStayM = msg.match(/maximum stay for \S+ is (\d+) nights/i);
          if (maxStayM) {
            return { error: `На эти даты максимальный срок брони — ${maxStayM[1]} ноч. Предложи гостю сократить срок или другие даты.` };
          }
          if (/arrival is closed/i.test(msg)) {
            return { error: 'На эту дату заезд закрыт. Предложи гостю другую дату заезда.' };
          }
          // Overbooking guard (or PMS refusal): tell the model plainly so it
          // offers other dates/apartments instead of retrying the same slot.
          if (/refused|already booked|occupied|занят/i.test(msg)) {
            return {
              error: 'Причина: эта квартира ЗАНЯТА (забронирована) на эти даты — НЕ про вместимость. Скажи гостю именно «квартира занята на эти даты» (НЕ «не вмещает»). Предложи другие даты или другую квартиру. НЕ создавай бронь на занятые даты.',
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
        // The Bnovo pay link is a FIRST-NIGHT PREPAYMENT, not the full total.
        // Surface that split so the bot never quotes the total and then hands
        // over a link showing a smaller number (guest: "а почему 8000?").
        const nights = Math.max(
          1,
          Math.round((Date.parse(input.checkOut) - Date.parse(input.checkIn)) / 86400000),
        );
        const prepayment = Math.round(input.totalPrice / nights); // first night
        return {
          ...booking,
          nights,
          prepayment,
          paymentNote:
            `Ссылка на оплату — это ПРЕДОПЛАТА за 1-ю ночь: ${prepayment} ₽. ` +
            `Всего за ${nights} ноч. — ${input.totalPrice} ₽, остаток при заселении. ` +
            `Обязательно скажи гостю ОБЕ суммы: по ссылке спишется ${prepayment} ₽ (предоплата), всего ${input.totalPrice} ₽.`,
        };
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
        if (isPaymentWindowDead(getBookingContact(bookingId), cancelMs, Date.now())) {
          return { error: 'Эта бронь отменена/просрочена (не оплачена вовремя) — старая ссылка недействительна. Нужно оформить бронь заново.' };
        }
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
        // Was this booking already paid? Confirm regardless of age — a paid
        // booking is never "dead". Check paid FIRST so an old-but-paid booking
        // still reports paid instead of being treated as an expired hold.
        if (pms.isBookingPaid && (await pms.isBookingPaid(bookingId))) {
          audit('check_payment', { chatId, bookingId, paid: true });
          return { bookingId, paid: true };
        }
        // Unpaid + (cancelled OR hold window expired) => the pay page is dead.
        // Don't tell the guest to keep paying an old, never-paid booking.
        if (isPaymentWindowDead(getBookingContact(bookingId), cancelMs, Date.now())) {
          return { bookingId, cancelled: true, note: 'Бронь была отменена/просрочена (не оплачена вовремя). НЕ проси оплачивать по старой ссылке. Предложи оформить заново, если гость ещё хочет.' };
        }
        if (!pms.isBookingPaid) return { error: 'Проверка оплаты недоступна для этого объекта' };
        audit('check_payment', { chatId, bookingId, paid: false });
        return { bookingId, paid: false };
      },
    },
    {
      name: 'apartment_amenities',
      description:
        'Получить полное описание квартиры (что есть в квартире: кухня, техника, санузел, удобства, правила). Вызывай, когда гость спрашивает про конкретное: «есть ли холодильник/кондиционер/стиральная машина/Wi-Fi/посуда» и т.п. Передай адрес квартиры в query (как показывал гостю). Описание — полный список оснащения: если упомянуто — «да, есть»; если НЕ упомянуто — значит этого в квартире нет, отвечай «нет» (не выдумывай и не отправляй к администратору).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Адрес квартиры (как показывал гостю)' },
          propertyId: { type: 'string', description: 'ID квартиры, если знаешь точно' },
        },
        required: [],
      },
      handler: async (a) => {
        if (!pms.getDescription) return { error: 'Описание недоступно для этого объекта' };
        // Resolve the property id: explicit id, or token-match the address.
        let id = a.propertyId ? String(a.propertyId) : undefined;
        if (!id && a.query) {
          const props = await pms.listProperties();
          const norm = (s: string) =>
            s.toLowerCase().replace(/[^a-zа-я0-9\s]/gi, ' ').split(/\s+/)
              .filter((t) => t.length >= 2 && !['улица', 'проспект', 'переулок', 'дом', 'канала', 'набережная', 'остров', 'острова'].includes(t));
          const qt = norm(String(a.query));
          const hit = props.find((p) => {
            const tt = new Set(norm(p.title));
            return qt.length > 0 && qt.every((t) => tt.has(t));
          });
          id = hit?.id;
        }
        if (!id) return { error: 'Не нашёл квартиру. Передай query с адресом как в check_availability.' };
        const rcId = await toRcId(id);
        const description = rcId ? await pms.getDescription(rcId) : null;
        if (!description) return { error: 'Описание этой квартиры пока недоступно — уточни у администратора.' };
        audit('apartment_amenities', { chatId, propertyId: id });
        return { description };
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
        'Отправить клиенту фото квартир с подписью (адрес + цена). Проще всего передай query — адрес(а) квартир через запятую, как ты их показывал гостю (напр. "Бронницкая 16, Рубинштейна 24"). Можно и propertyId/propertyIds. НЕ говори, что фото нет, не вызвав этот инструмент.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Адрес(а) квартир через запятую (как показывал гостю) — найду по названию',
          },
          propertyId: { type: 'string', description: 'ID одной квартиры (если знаешь точно)' },
          propertyIds: {
            type: 'string',
            description: 'Несколько ID через запятую',
          },
          checkIn: { type: 'string', description: 'Дата заезда YYYY-MM-DD — чтобы указать цену в подписи' },
          checkOut: { type: 'string', description: 'Дата выезда YYYY-MM-DD' },
          guests: { type: 'integer', description: 'Число гостей — чтобы цена в подписи совпадала с check_availability' },
        },
        required: [],
      },
      handler: async (a) => {
        if (!messenger.sendPhotos) return { error: 'Отправка фото недоступна в этом канале' };
        const props = await pms.listProperties();
        const titles = new Map(props.map((p) => [p.id, p.title]));
        // Token-based match: every significant token of the query (street word +
        // house number) must appear in the title. Handles "Бронницкая 16" vs
        // "Бронницкая улица 16" where a plain substring check fails.
        const tokens = (s: string) =>
          s
            .toLowerCase()
            .replace(/[^a-zа-я0-9\s]/gi, ' ')
            .split(/\s+/)
            .filter((t) => t.length >= 2 && !['улица','проспект','переулок','дом','канала','набережная','остров','острова'].includes(t));

        const ids = [
          ...(a.propertyId ? [String(a.propertyId)] : []),
          ...(a.propertyIds ? String(a.propertyIds).split(',').map((s) => s.trim()) : []),
        ].filter(Boolean);
        if (a.query) {
          for (const term of String(a.query).split(',').map((s) => s.trim()).filter(Boolean)) {
            const qt = tokens(term);
            if (qt.length === 0) continue;
            // Match ALL apartments at this address, not just the first — one
            // address can be several distinct flats (Бронницкая 16 has two).
            const hits = props.filter((p) => {
              const tt = new Set(tokens(p.title));
              return qt.every((t) => tt.has(t));
            });
            for (const hit of hits) if (!ids.includes(hit.id)) ids.push(hit.id);
          }
        }
        // Drop anything that isn't a real property id (model may hallucinate).
        const validRaw = ids.filter((id) => titles.has(id));
        if (validRaw.length === 0) {
          return { error: 'Не нашёл эти квартиры. Передай query с адресом как в check_availability.' };
        }

        // Price for the caption — always show it (Al's request). Use the guest's
        // dates if given, else the next night, so the number is meaningful.
        const ci = (a.checkIn as string) || new Date().toISOString().slice(0, 10);
        const co = (a.checkOut as string) || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        // Use the SAME guest count as the search, so the caption price matches
        // the list price. A hardcoded 2 caused "8000 в подписи, 9000 в списке".
        const pGuests = a.guests ? Number(a.guests) : 2;
        const priceById = new Map<string, number | undefined>();
        for (const id of validRaw) {
          try {
            const rc = await toRcId(id);
            const av = rc ? await pms.checkAvailability({ propertyId: rc, checkIn: ci, checkOut: co, guests: pGuests }) : [];
            priceById.set(id, Array.isArray(av) ? av[0]?.totalPrice : undefined);
          } catch { /* ignore */ }
        }

        // Dedup by (address + price): several identical rooms at one address
        // (Рубинштейна 24 ×3 @8000) send once; genuinely different flats at the
        // same address (Бронницкая 16 @10000 vs @13000) each stay.
        const valid: string[] = [];
        const seenKey = new Set<string>();
        for (const id of validRaw) {
          const key = `${titles.get(id)}|${priceById.get(id) ?? '?'}`;
          if (seenKey.has(key)) continue;
          seenKey.add(key);
          valid.push(id);
        }

        // Keep the volume modest — fresh Telegram accounts have tight media
        // limits. Fewer photos per apartment + fewer apartments per request
        // keeps us well under FloodWait; the messenger queue spaces them out.
        const MAX_APTS = 4;
        const MAX_PER_APT = 5;

        const results: Array<{ propertyId: string; sent: number }> = [];
        const empty: string[] = [];
        const chosen = valid.slice(0, MAX_APTS);

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
          const baseTitle = titles.get(id) ?? id;
          // Always put the price in the caption (Al's request).
          const price = priceById.get(id);
          const caption = c
            ? `${c.title}${c.price ? ` — ${c.price} ₽/ночь` : ''}`
            : `${baseTitle}${price ? ` — ${price} ₽` : ''}`;
          await messenger.sendPhotos(chatId, urls.slice(0, MAX_PER_APT), caption);
          audit('send_apartment_photos', { chatId, propertyId: id, count: Math.min(urls.length, MAX_PER_APT) });
          results.push({ propertyId: id, sent: Math.min(urls.length, MAX_PER_APT) });
        }

        // Apartments beyond the per-request cap weren't sent — offer them next.
        const remaining = valid.slice(MAX_APTS).map((id) => titles.get(id) ?? id);
        if (results.length === 0) {
          return { error: `Фото не найдены для: ${empty.join(', ') || ids.join(', ')}` };
        }
        return {
          ok: true,
          sent: results.map((r) => titles.get(r.propertyId) ?? r.propertyId),
          remainingCount: remaining.length, // ask "показать ещё N?" if > 0
          remaining, // addresses not yet shown (cap)
        };
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
