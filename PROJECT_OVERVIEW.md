# AI-Manager — полный разбор проекта

> Документ-«карта» всего, что построено: архитектура, все фичи, все инструменты/эндпоинты, база, фон, деплой. Организовано по слоям — чтобы легко ориентироваться и расширять.

---

## 0. Что это такое (одним абзацем)

ИИ-агент, который ведёт переписку с гостем в мессенджере вместо живого администратора аренды посуточно: квалифицирует, подбирает квартиры, шлёт фото, называет цены, **сам создаёт бронь в PMS**, выдаёт ссылку на оплату, проверяет оплату, дожимает неоплаченные брони (напоминание → авто-отмена), и раздаёт горничным прогноз выездов. Всё построено **за интерфейсами** — мессенджер, LLM и PMS взаимозаменяемы, агент про них ничего не знает.

**Текущий прод:** 2 клиента одновременно на одном сервере —
- Дмитрий (`@dima_pro_admin`, Чита) → PMS **RealtyCalendar**
- Артём (`@artem_pro_admin`, СПб) → PMS **Bnovo**

Мессенджер — **Telegram (личный аккаунт через gramjs)**, LLM — **WaveSpeed `deepseek/deepseek-v4-flash`**.

---

## 1. Стек и структура

**Стек:** TypeScript (ESM) · Node ≥ 20 · Fastify (HTTP) · Postgres (`postgres` пакет) · Zod (валидация env) · pino (логи) · `tsx` (запуск .ts напрямую, без сборки) · gramjs/`telegram` (MTProto) · bcryptjs + jsonwebtoken (auth).

**Запуск:** `npm run dev` (tsx watch) / прод — `tsx src/index.ts` под pm2. Сборка не нужна — **исходник = то, что бежит на сервере**.

```
src/
  index.ts            # точка входа: собирает всё и слушает порт
  config.ts           # ВСЕ env-переменные (Zod), единственный источник конфигурации
  logger.ts           # pino (прод: JSON в logs/app.log; дев: pretty)
  safety.ts           # предохранители: kill-switch, валидация, идемпотентность, аудит

  messenger/          # СЛОЙ МЕССЕНДЖЕРА (за интерфейсом)
    types.ts          #   interface Messenger + IncomingMessage + MessageHandler
    telegram.ts       #   Bot API (webhook/polling)
    telegram-user.ts  #   личный аккаунт (gramjs/MTProto) — текущий прод
    session-lock.ts   #   один процесс = одна сессия (защита от бана)

  llm/                # СЛОЙ LLM (взаимозаменяемый)
    types.ts          #   interface LlmProvider + ToolSchema
    wavespeed.ts      #   WaveSpeed (OpenAI-совместимый) — текущий прод
    gemini.ts         #   Gemini (запасной)

  pms/                # СЛОЙ PMS (взаимозаменяемый, по владельцу)
    types.ts          #   interface PmsConnector
    bnovo.ts          #   Bnovo (реверс веб-кабинета) — самый сложный
    realtycalendar.ts #   RealtyCalendar (реверс)
    stub.ts           #   фейковый PMS в памяти (для отладки)
    for-owner.ts      #   createPmsForOwner(id) — выбор PMS по владельцу из БД
    index.ts          #   createPms() — legacy single-tenant по env

  agent/              # ДВИЖОК ДИАЛОГА
    agent.ts          #   Agent.handle(msg): история, вызов LLM, ответ
    tools.ts          #   ВСЕ инструменты (check_availability, create_booking, ...)
    prompt.ts         #   системный промпт (тон/воронка/политики/сценарии)

  payment-watcher.ts  # фон: опрос оплаты + дожим + авто-отмена
  housekeeping.ts     # фон: напоминание о выезде + прогноз горничным + scheduleDaily

  api/apartments.ts        # owner API v2 (JWT, БД, CRUD квартир)
  frontend/admin-api.ts    # legacy admin (один токен, JSON-файл)
  frontend/apartments-info.ts # JSON-хранилище инфо квартир (legacy)
  frontend/photos.ts       # хранение фото под data/photos/<id>/
  frontend/routes.ts       # публичная страница квартиры /apt/:id
  auth/auth.ts             # register/login (bcrypt + JWT)

  db/index.ts, migrate.ts, schema.sql  # Postgres: users, apartments, apartment_photos
  store/booking-contacts.ts  # JSON: bookingId → chat (для дожима/напоминаний)
  store/apartments-repo.ts   # чтение карточек квартир владельца из БД

  scripts/*.ts        # смоук-тесты (bnovo-smoke, rc-smoke, checkout-smoke, e2e-agent, seed-pilot)
```

**Ключевой принцип:** `agent/` зависит **только** от интерфейсов `Messenger`, `LlmProvider`, `PmsConnector`. Замена мессенджера или PMS = один новый файл, реализующий интерфейс. Всё остальное не трогается.

---

## 2. Поток одного сообщения (как всё работает)

```
Гость пишет в мессенджер
      │
      ▼
Messenger (telegram-user.ts) ловит сообщение (push-событие ИЛИ polling)
      │  нормализует в IncomingMessage { chatId, senderName, text, providerMessageId, timestamp }
      ▼
Agent.handle(msg)
      │  1. дедуп по chatId:providerMessageId (webhook-ретраи не дублируются)
      │  2. берёт/создаёт history[chatId], добавляет {role:user, text}
      │  3. buildTools({pms, messenger, chatId, session})  ← инструменты на этот чат
      │  4. llm.runTurn({ systemPrompt(today), history, tools })
      ▼
LlmProvider.runTurn (wavespeed.ts) — цикл tool-hop (до 6 раз):
      │  → POST /chat/completions с messages+tools
      │  → если модель вернула tool_calls: выполнить handler'ы (check_availability,
      │     create_booking, send_apartment_photos, ...) → скормить результаты обратно
      │  → повторять, пока модель не вернёт финальный текст
      ▼
Agent: добавляет {role:assistant, text} в history (обрезка до 30), messenger.sendMessage(chatId, reply)
      ▼
Гость получает ответ

Параллельно, в фоне:
  payment-watcher (каждую минуту) — опрашивает неоплаченные брони, дожимает, отменяет
  housekeeping (scheduleDaily) — вечером напоминает о выезде + прогноз горничным
```

---

## 3. Слой мессенджера

### Интерфейс — `src/messenger/types.ts`

```ts
interface IncomingMessage {
  chatId: string;            // стабильный id чата (строка)
  senderName?: string;
  text: string;
  providerMessageId: string; // id сообщения провайдера — для дедупа
  timestamp: number;         // Unix-секунды
}

interface Messenger {
  readonly name: 'telegram' | 'max';
  sendMessage(chatId: string, text: string): Promise<void>;
  sendPhotos?(chatId: string, urls: string[], caption?: string): Promise<void>;  // опционально
  init(): Promise<void>;
}

type MessageHandler = (msg: IncomingMessage) => Promise<void>;
```

### Две реализации Telegram (разница)

- **`telegram.ts`** — официальный **Bot API** (HTTP REST + webhook/polling). `initWebhook()` регистрирует `POST /webhook/...`, отвечает `{ok:true}` мгновенно и обрабатывает асинхронно (чтобы провайдер не ретраил на медленном LLM), `sendMessage` = POST на REST, `normalize()` строит `IncomingMessage`.
- **`telegram-user.ts`** — **личный аккаунт** через gramjs/MTProto (текущий прод, потому что бот-аккаунт не подходит). Тут вся Telegram-специфика: `StringSession`, device fingerprint, прокси, polling, альбомы, session-lock.

### Важные механики `telegram-user.ts`

- **Serialized send queue (`enqueueSend`)** — все отправки идут через одну очередь с паузой `GAP_MS=3000` и обработкой rate-limit (FloodWait): при ошибке лимита ждёт указанное время (до 5 мин) и повторяет один раз, иначе роняет отправку (не кидает). Спасает от бана за флуд.
- **Дедуп `lastSeen: Map<chatId, maxMsgId>`** — и push-события, и polling идут через один `handleMessage`, который пропускает уже виденные id. Идемпотентность.
- **`sendPhotos` как альбом** — качает байты сам (`fetch` → буфер → загрузка), шлёт media-group одним сообщением с подписью. Причина: прямые URL к media часто отклоняются (`MEDIA_INVALID`), а по-штучно = flood. Лимит: 10 фото/альбом.
- **`withTimeout`** — обёртка над сетевыми вызовами, чтобы зависший провайдер не вешал цикл.
- **Polling-режим (`TG_POLLING`)** — на прямом IP (без гео-прокси) push-updates не приходят, поэтому сообщения опрашиваются через `getDialogs` каждые ~4с.

### `session-lock.ts`

Защита «один процесс = одна сессия»: две копии одной Telegram-сессии → `AUTH_KEY_DUPLICATED` → бан аккаунта. Лок-файл в tmpdir по хэшу сессии; atomic create; проверка живости PID; авто-очистка на SIGINT/SIGTERM.

---

## 4. Слой LLM

### Интерфейс — `src/llm/types.ts`

```ts
interface LlmProvider { runTurn(input: LlmTurnInput): Promise<string>; }
interface LlmTurnInput { systemPrompt: string; history: LlmMessage[]; tools: ToolSchema[]; }
type LlmMessage = {role:'user';text:string} | {role:'assistant';text:string};
interface ToolSchema {
  name: string; description: string;
  parameters: { type:'object'; properties: Record<string,ToolParameter>; required: string[] };
  handler: (args) => Promise<unknown>;   // ← исполняемая функция инструмента
}
```

### `wavespeed.ts` — текущий провайдер (OpenAI-совместимый)

- **Base:** `https://llm.wavespeed.ai/v1`, авторизация `Authorization: Bearer <WAVESPEED_API_KEY>`.
- **Модель:** `WAVESPEED_MODEL` = `deepseek/deepseek-v4-flash` (выбрана по цене/качеству — см. §11).
- **Tool-loop** (до `MAX_TOOL_HOPS=6`): POST `/chat/completions` с `{model, messages, tools, tool_choice:'auto'}`; если пришли `tool_calls` — эхом кладёт assistant-сообщение с tool_calls, исполняет каждый `handler`, кладёт результат как `{role:'tool', tool_call_id, content: JSON({result})}`, повторяет; иначе возвращает текст. Ретраи на 429/5xx/сетевых (3 попытки, backoff 500·n).
- Инструменты конвертируются в OpenAI-схему `toOpenAiTool`.

### `gemini.ts` — запасной (был первым)

SDK `@google/genai`. Отличия: system-prompt как `systemInstruction`, эхо tool-call с `thoughtSignature` (требование Gemini 3.x), tools параллельно, 429 **не** ретраит. **Почему ушли:** у Gemini закончились предоплаченные кредиты (429 RESOURCE_EXHAUSTED) → перешли на WaveSpeed.

**Переключение провайдера:** `LLM_PROVIDER=wavespeed|gemini` в env.

---

## 5. Движок агента — `src/agent/`

### `agent.ts`

`Agent.handle(msg)`: дедуп (`seen: Set<chatId:msgId>`), история в памяти (`Map<chatId, LlmMessage[]>`, обрезка `MAX_HISTORY=30`), сессия (`Map<chatId, {lastBookingId?}>`), сборка инструментов на чат, вызов `llm.runTurn`, ответ через messenger. **История — в памяти** (при рестарте теряется; в планах — Postgres).

### `tools.ts` — каталог инструментов

Две модели владельца:
- **Direct-PMS** (Bnovo): PMS — источник истины, карточек в БД нет, `propertyId` идёт напрямую. `isDirectPms()` = у владельца 0 карточек в БД.
- **DB-card** (RealtyCalendar): квартиры — карточки в нашей БД со ссылкой `rc_apartment_id`, модель оперирует нашими id.

| Инструмент | Параметры | Что делает |
|---|---|---|
| `list_properties` | — | Список квартир (id, title, price). |
| `check_availability` | checkIn, checkOut, guests, `area?`, `maxPrice?`, `minPrice?`, propertyId? | Доступность + цена. Возвращает `{total, filtered, results}`. **Предфильтр:** `area` (подстрока адреса/района), `maxPrice`/`minPrice` (бюджет за период). Дедуп одинаковых адресов. |
| `create_booking` | propertyId, checkIn, checkOut, guests, guestName, guestPhone?, totalPrice | `assertAutonomyEnabled()` → `validateBooking()` → идемпотентный ключ → `pms.createBooking`. **Ловит овербукинг** (ошибка «занято» → говорит модели предложить другое, не ретраить). Пишет `session.lastBookingId`, `rememberBookingContact` (связь бронь↔чат), `audit`, `notifyOwner`. |
| `get_payment_link` | bookingId? | `assertAutonomyEnabled()` → `pms.getPaymentLink`. Ссылка на оплату. |
| `check_payment` | bookingId? | `pms.isBookingPaid` → `{paid}`. Проверка оплаты (не на слово гостя). |
| `send_apartment_photos` | query? (адреса через запятую), propertyId?, propertyIds?, checkIn?, checkOut? | Фото альбомами. Токен-матч по адресу (находит ВСЕ квартиры адреса), дедуп по (адрес+цена), лимит 4 квартиры × 5 фото, цена в подписи, `remainingCount` для «показать ещё?». |
| `get_apartment_info` | propertyId | Ссылка на страницу квартиры (правила/заселение). |
| `confirm_checkout_time` | time (ЧЧ:ММ) | Записывает подтверждённое время выезда. |

Инфраструктура: `assertAutonomyEnabled()` (kill-switch на денежных действиях), `audit()` (аудит-лог), `bookingIdempotencyKey()`, `validateBooking()`, `notifyOwner()`.

### `prompt.ts` — системный промпт

Функция `systemPrompt(today)` — русский текст, **дистиллят из 109 скринов реальной переписки хозяина**. Принцип: **кодирует поведение, не данные** (цены/адреса/коды НЕ хардкодятся — только из инструментов, иначе эскалация). Секции: ТОН · ВОРОНКА(1..8) · ПОЛИТИКИ · ИНСТРУМЕНТЫ · ТИПОВЫЕ СИТУАЦИИ · БЕЗОПАСНОСТЬ. Знание тона/сценариев — в `knowledge/TONE.md`, `KNOWLEDGE.md`, `SCENARIOS.md`.

---

## 6. Слой PMS

### Интерфейс — `src/pms/types.ts`

```ts
interface PmsConnector {
  listProperties(): Promise<Property[]>;
  checkAvailability(q): Promise<AvailabilityResult[]>;
  createBooking(input): Promise<Booking>;
  getPaymentLink(bookingId): Promise<PaymentLink>;
  getCheckouts(isoDate): Promise<Checkout[]>;
  getPhotos?(propertyId): Promise<string[]>;      // опционально
  isBookingPaid?(bookingId): Promise<boolean>;     // опционально
  cancelBooking?(bookingId): Promise<boolean>;     // опционально
}
```
Даты ISO `YYYY-MM-DD`, checkIn включительно, checkOut исключительно. Bnovo реализует все 3 опциональных, RC — только `getPhotos`, Stub — ничего.

### `bnovo.ts` — реверс веб-кабинета (самый сложный, полная карта эндпоинтов)

Base `https://online.bnovo.ru`, авторизация = **cookie `SID`** (авто-логин по username/password, авто-refresh при `session_expired`/401/403).

| Возможность | Эндпоинт | Метод | Ключевые параметры | Что берём из ответа |
|---|---|---|---|---|
| login | `/` | POST form | `mat='', username, password`, redirect:manual | `Set-Cookie` → `SID=...` |
| брони+закрытия | `/planning/bookings` | POST **multipart** | `dfrom, dto, daily=0` | `result[]` (брони), `closures[]` |
| презентация (адрес+фото) | `/roomTypes/get_room_presentation_data?rp=vue` | POST JSON | `{room_type_id}` | `data.pms_room_type.description` (адрес), `data.photos[].url` |
| цены | `/roomTypes/getRoomTypeVariation` | POST JSON | **`adultCustomerCount`** (ЕД. ЧИСЛО!), `childrenAges:{}`, `dateFrom, dateTo`, `planId:Number`, `isEarlyArrival:false`, `isLateDeparture:false` | `data.variation[].{roomtype_id, roomtype_name, placings[0].price}` (цена за весь период) |
| создать бронь | `/booking/add` | POST JSON | `date_from, date_to=checkOut`, `room_types[1].room_types` по каждой ночи, `force:true`, `plan_id`, `marketing` | `{result:'success', first_booking_id}` |
| отмена | `/bookings/changeStatus` | POST JSON | `new_status_id:'2'`, `cancel_reason_id:40503`, `booking_number` | 200 = ок |
| счёт брони | `/booking/getInvoices` | POST JSON | `{bookingId}` | `data.invoices.online[0].id` |
| ссылка оплаты | `/invoices/invoice_pdf_link?invoice_id=<id>` | GET | id счёта | `url` (payment.bnovo.ru) |
| оплачено? | `/booking/invoices/<bookingId>/` | GET HTML | — | regex `has_not_null_payments value="(\d+)"` → `>0` |
| выезды на дату | `/planning/bookings` | POST | `date .. date+1` | строки где `real_departure` = date |

**Критичные грабли Bnovo (все на своей крови):**
1. **`dual_roomtype_id` = это room_type_id для брони.** Приходит **то строкой, то числом** — везде `Number(...)`. Из-за этого «плавала» цена (индекс числовой, ключ строковый не находился).
2. **`adultCustomerCount` — единственное число** (множественное `adultCustomersCount` отвергается). На этом застревали.
3. **`date_to = дата выезда** (checkOut), room_types keyed по каждой ночи checkIn..checkOut−1.
4. **`force:true`** в `/booking/add` — иначе Bnovo отклоняет валидные брони той же категории. НО force позволяет создать **поверх занятой** → отсюда `isRoomFree()` guard перед созданием (свежая проверка, отказ если занято).
5. **Цена по двум индексам** (`byTypeId` + `byLabel`), т.к. id-пространства variation и броней не совпадают. Матч: typeId → кличка → номер → адрес, всё через `normLabel` (убрать пробелы/скобки: «Руб 2»↔«Руб2»).
6. **Дедуп по (адрес+цена):** один адрес = несколько квартир; одинаковые схлопываются, разные по цене (Бронницкая 10000 vs 13000) остаются с различителем.
7. **Прайс ≠ per-night**, `placings[0].price` — за весь период.

> **Оговорка (нашёл при аудите):** правило «arrival_time ≥ 15:00» есть в **промпте/reverse-заметках**, но в коде `bnovo.ts` `arrival_time` = дефолт `14:00` (жёсткого клампа нет).

### `realtycalendar.ts` — второй PMS

Реверс. Авторизация = **2 заголовка**: `x-user-token` (долгоживущий) + `Cookie`, обязателен `User-Agent`. DB-card режим. Эндпоинты `/v2/apartments`, `/v2/event_calendars` (даты YYYY-MM-DD для чтения, DD.MM.YYYY для создания), `/v2/event_calendars/{id}/deposits` (ссылка оплаты). Реализует только `getPhotos`.

### Выбор PMS — `for-owner.ts`

`createPmsForOwner(ownerId)`: `SELECT pms_provider, pms_credentials FROM users WHERE id=ownerId`, switch: `realtycalendar` → `RealtyCalendarClient`, `bnovo` → `BnovoClient`, иначе `StubPms`. **Кэш по владельцу** (не пересоздавать/не пере-логиниться на каждое сообщение). `invalidateOwnerPms(id)` — сбросить после смены кредов.

---

## 7. База данных — `src/db/schema.sql`

```
users            id, email UNIQUE, phone UNIQUE, password_hash, name, created_at,
                 pms_provider TEXT DEFAULT 'stub', pms_credentials JSONB DEFAULT '{}'
                 CHECK (email IS NOT NULL OR phone IS NOT NULL)
apartments       id, owner_id→users, title, address, price, rules, checkin_instructions,
                 wifi_name, wifi_password, extra, rc_apartment_id, created_at, updated_at
apartment_photos id, apartment_id→apartments, file_name, sort_order, created_at
```
Миграция идемпотентна (`IF NOT EXISTS`), запуск `npm run migrate`. **Связь бронь↔чат — НЕ в БД, а в JSON** (`data/booking-contacts.json`).

**Мультитенантность:** каждый владелец = строка в `users` со своим `pms_provider` + `pms_credentials` (JSONB с логином/паролем/токенами PMS). Так два клиента (RC и Bnovo) работают одновременно.

---

## 8. Фоновые процессы

### `payment-watcher.ts` — оплата + дожим + отмена

`startPaymentWatcher({pms, messenger})`. Отключается, если у PMS нет `isBookingPaid`. **Self-scheduling loop** (не `setInterval` — чтобы медленная отмена не запускала перекрывающиеся tick'и). Каждую минуту по неоплаченным броням (в окне `createdAt < cancelMs + 1ч`):
1. **оплачено** → «оплату вижу, спасибо 👍», `markPaidNotified`, стоп.
2. **age ≥ `PAYMENT_CANCEL_MS` (30 мин)** → пометить `cancelled` СНАЧАЛА (дедуп) → сообщить гостю → `pms.cancelBooking`.
3. **age ≥ `PAYMENT_REMIND_MS` (15 мин)** и не напоминали → напоминание (+`MANAGER_PHONE` если задан), пометить `paymentReminded`.

Флаги (`paidNotified`/`paymentReminded`/`cancelled`) пишутся ДО async-действия → рестарт/перекрытие не дублируют. Проверено вживую: 1 напоминание, 1 отмена, бронь реально снимается.

### `housekeeping.ts` — горничные

- `remindGuestsAboutCheckout()` — вечером DM гостям с выездом завтра: «во сколько выезжаете?» (ответ ловит `confirm_checkout_time`).
- `postTomorrowForecast()` — в чат горничных (`HOUSEKEEPING_CHAT_ID`) список выездов на завтра со временами.
- `scheduleDaily(hour, fn)` — мини-планировщик без cron (`setInterval` 60с, срабатывает в нужный час:00). Часы задаются в `index.ts` (18:00 напоминание, 21:00 прогноз).

---

## 9. Админка / API / публичные страницы

- **`api/apartments.ts`** — owner API v2 (`/api/v2`), **JWT** per-user, БД: register/login, CRUD квартир, загрузка/удаление фото. Основной.
- **`frontend/admin-api.ts`** — legacy admin (`/api/admin`), **один `ADMIN_TOKEN`**, хранит в JSON-файле. Старый.
- **`frontend/routes.ts`** — публичная страница `GET /apt/:id` (адрес/правила/wifi/фото, self-contained HTML). `apartmentPageUrl(id)` бот шлёт гостю.
- **`frontend/photos.ts`** — фото под `data/photos/<id>/`, отдаются через `GET /photos/:id/:file`.
- **`auth/auth.ts`** — bcrypt (hash 10) + JWT (`JWT_SECRET`, TTL 30д).

**Роуты (index.ts):** `GET /health`, `GET /photos/:id/:file`, `POST /admin/forecast`, `POST /admin/checkout-reminders`, плюс `/api/admin/*`, `/api/v2/*`, `/apt/:id`, и (для Bot API webhook) `POST /webhook/telegram/:secret`.

---

## 10. Предохранители (`safety.ts`) — агент автономен на деньгах

- `AUTONOMY_ENABLED=false` — мгновенно замораживает `create_booking` и `get_payment_link`.
- `MIN_BOOKING_TOTAL` / `MAX_BOOKING_TOTAL` — отсечка подозрительных сумм.
- `bookingIdempotencyKey = chatId:propertyId:checkIn:checkOut` — повтор/сбой не создаёт дубль.
- `audit()` — каждое денежное действие в лог; `notifyOwner()` — уведомление владельцу.
- `validateBooking()` — даты не в прошлом, checkout после checkin, guests > 0, сумма в диапазоне.

---

## 11. LLM: выбор модели (замеры)

Сравнили на реальном промпте+инструментах (RU, многошаговый диалог). Цена $/1M вход/выход:

| Модель | Вход | Выход | Итог |
|---|---|---|---|
| **deepseek-v4-flash** ✅ | $0.17 | $0.34 | **выбрана** — качество на уровне, дешевле всех |
| minimax-m3 | $0.60 | $2.40 | хорош, ×7 дороже |
| claude-haiku-4.5 | $0.95 | $4.80 | хорош, ×14 |
| gpt-5.4 | $2.50 | $15.0 | дорого ×44, медленно |
| gpt-5.4-mini | — | — | брак: дублировал текст, «Да.» на «да» |

**Реальный кост:** полный флоу клиента (6 сообщений до брони) ≈ **$0.013 (~1.2₽)**, одно сообщение ≈ **$0.002 (~0.2₽)**. 94% коста — input (большой промпт × вызовы). Баланс $9.39 ≈ 700 броней.

---

## 12. Деплой и pm2

- **VPS:** `root@178.88.115.213`, каталог `/opt/ai-manager`. Деплой — **пофайлово по SSH** (`scp`), НЕ git на сервере. Бежит через `tsx` (без сборки).
- **pm2 — ДВА процесса** (важно, в репо не закоммичено — только на VPS):
  - `ai-manager` (cluster, 1 инстанс) — владелец #2 RealtyCalendar, env `.env`, порт **3020**
  - `ai-manager-bnovo` (fork) — владелец #3 Bnovo, env `.env.bnovo` через `DOTENV_CONFIG_PATH`, порт **3021**
- Оба на **прямом IP + `TG_POLLING=true`** (прокси Decodo мёртв; на прямом IP push-updates не идут, поэтому polling).
- `ecosystem.config.cjs` в репо описывает **один** процесс (шаблон) — реальная двух-процессная топология применена руками на VPS.
- pm2: `pm2 start`, `pm2 restart <name> --update-env`, `pm2 save` (переживает перезагрузку), логи `logs/app.log` (прод — синхронный JSON).

**Секреты (в `.gitignore`, НЕ в git):** `.env*`, TG-сессии, `data/booking-contacts.json`, `data/photos/`, реверс-дампы Bnovo (`bookings.json`, `logs_network.txt`, `bnovo_*.json`), `knowledge/_bnovo_reverse.md` (логин/пароль Bnovo), `photos/` (скрины с PII/картой хозяина). Бизнес-знание `knowledge/{KNOWLEDGE,SCENARIOS,TONE}.md` — в git (репо приватное).

---

## 13. Все env-переменные (`config.ts`)

| Группа | Переменные |
|---|---|
| Сервер | `PORT` (3000), `PUBLIC_URL`, `LOG_LEVEL` (info) |
| LLM | `LLM_PROVIDER` (gemini\|wavespeed), `WAVESPEED_API_KEY`, `WAVESPEED_MODEL` (deepseek-v4-flash), `WAVESPEED_BASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_BASE_URL` |
| Мессенджер | `MESSENGER` (telegram\|telegram-user\|max), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_MODE`, `TELEGRAM_WEBHOOK_SECRET` |
| TG-аккаунт | `TG_API_ID`, `TG_API_HASH`, `TG_SESSION`, `TG_PROXY`, `TG_USERNAME`, `TG_PRIVATE_ONLY` (true), `TG_POLLING`, `TG_POLL_INTERVAL_MS` (4000) |
| Оплата | `MANAGER_PHONE`, `PAYMENT_REMIND_MS` (15м), `PAYMENT_CANCEL_MS` (30м) |
| Чаты | `HOUSEKEEPING_CHAT_ID`, `OWNER_CHAT_ID` |
| Админ/auth | `ADMIN_TOKEN`, `ADMIN_CORS_ORIGIN` (*), `JWT_SECRET`, `AGENT_OWNER_ID` |
| PMS (RC/env) | `PMS_PROVIDER` (stub\|realtycalendar), `RC_BASE_URL`, `RC_USER_TOKEN`, `RC_COOKIE`, `RC_USER_AGENT`, `RC_DEFAULT_DEPOSIT` (2500) |
| БД/автономия | `DATABASE_URL`, `AUTONOMY_ENABLED` (true), `MAX_BOOKING_TOTAL`, `MIN_BOOKING_TOTAL` |

---

## 14. Хронология (43 коммита — что делали по порядку)

Скелет → RC-коннектор + Telegram polling + pm2 → бизнес-правила + страница квартиры + Gemini-прокси → личный TG-аккаунт (gramjs) + session-lock → напоминания о выезде → админка квартир → фото (загрузка + отправка) → мультитенант (владельцы + Postgres) → per-owner PMS → промпт из 109 скринов → **Bnovo-коннектор** (реверс) → авто-логин → фиксы флоу (доступность/фото/дубли) → knowledge в git → direct-PMS режим → адреса+фото из Bnovo → **WaveSpeed вместо Gemini** → защита от овербукинга → оплата (ссылка+статус) → авто-детект оплаты → фото альбомами (fix FloodWait) → реальные цены Bnovo (100% покрытие) → предфильтр район+бюджет → **дожим+авто-отмена неоплаченных**.
