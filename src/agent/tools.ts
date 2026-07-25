import { config } from '../config.js';
import type { Messenger } from '../messenger/types.js';
import type { PmsConnector } from '../pms/types.js';
import type { ToolSchema } from '../llm/types.js';
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

  return [
    {
      name: 'list_properties',
      description: 'Список доступных квартир с ценами и вместимостью.',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => pms.listProperties(),
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
      handler: async (a) =>
        pms.checkAvailability({
          propertyId: a.propertyId as string | undefined,
          checkIn: a.checkIn as string,
          checkOut: a.checkOut as string,
          guests: Number(a.guests),
        }),
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
        const key = bookingIdempotencyKey({
          chatId,
          propertyId: a.propertyId as string,
          checkIn: input.checkIn,
          checkOut: input.checkOut,
        });
        const booking = await pms.createBooking({
          propertyId: a.propertyId as string,
          guestName: a.guestName as string,
          guestPhone: a.guestPhone as string | undefined,
          idempotencyKey: key,
          ...input,
        });
        session.lastBookingId = booking.id;
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
  ];
}
