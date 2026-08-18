# Как работает Telegram-аккаунт и поток сообщений

Документ описывает, как бот принимает и отправляет сообщения через **живой
Telegram-аккаунт** (не бот через BotFather), как крутится агент и куда что
пишется. Все ссылки на код — с путями до файлов.

---

## 1. Главное в двух словах

Бот — это **обычный пользовательский Telegram-аккаунт** (номер телефона), которым
управляет наш код через протокол **MTProto** (библиотека `telegram` / gramjs).
Для гостя это выглядит как переписка с живым администратором: то же имя, тот же
@username, личные сообщения. Никакого «бота» с синей плашкой нет.

Один запущенный процесс = один Telegram-аккаунт. Сейчас на сервере два таких
процесса (два аккаунта), каждый со своим `.env`-файлом.

| Процесс (pm2)      | env-файл       | Порт | Владелец (БД) | Аккаунт TG              |
|--------------------|----------------|------|---------------|-------------------------|
| `ai-manager`       | `.env`         | 3020 | `AGENT_OWNER_ID=2` | (питерский фонд)     |
| `ai-manager-bnovo` | `.env.bnovo`   | 3021 | `AGENT_OWNER_ID=3` | `@posytochno_demo_aimanager` (демо) |

> Оба процесса запущены с `MESSENGER=telegram-user`, `TG_POLLING=true`,
> `LLM_PROVIDER=wavespeed`.

---

## 2. Путь одного сообщения (сверху вниз)

```
Гость пишет в личку аккаунта
        │
        ▼
[ MTProto: событие ИЛИ поллинг ]      src/messenger/telegram-user.ts
        │  onEvent()  /  pollOnce()
        ▼
handleMessage()  — фильтры, дедуп, вытаскивание reply-цитаты
        │  формирует IncomingMessage
        ▼
Agent.handle(msg)                     src/agent/agent.ts
        │  грузит историю чата, добавляет сообщение гостя
        ▼
LlmProvider.runTurn()                 src/llm/wavespeed.ts
        │  цикл «модель ↔ инструменты» (до 6 шагов)
        │      ├─ модель зовёт инструмент → tools.ts выполняет
        │      └─ результат инструмента возвращается модели
        ▼
Готовый текст ответа
        │
        ▼
Agent: анти-зацикливание, сохранение истории, транскрипт
        │
        ▼
messenger.sendMessage() / sendPhotos()   src/messenger/telegram-user.ts
        │  очередь отправки с паузами + обработка FloodWait
        ▼
Гость получает ответ
```

---

## 3. Приём сообщений

Файл: **[src/messenger/telegram-user.ts](../src/messenger/telegram-user.ts)**
Класс `TelegramUserMessenger` (реализует интерфейс `Messenger` из
[src/messenger/types.ts](../src/messenger/types.ts)).

### 3.1. Подключение к аккаунту — `init()`

- Забирает `SessionLock` (см. раздел 6) — гарантия, что этой же сессией не
  пользуется второй процесс.
- Поднимает `TelegramClient` (gramjs) на трёх параметрах из `.env`:
  - `TG_API_ID`, `TG_API_HASH` — ключи приложения (берутся на my.telegram.org),
  - `TG_SESSION` — сохранённая строковая сессия (`StringSession`); в ней «запомнен»
    вход, поэтому код по СМС не нужен на каждый старт.
- Держит **стабильный «отпечаток устройства»** (`deviceModel: 'Desktop'`,
  `systemVersion: 'Windows 10'`, `appVersion`) — резкая смена устройства для
  Telegram = флаг.
- Если задан `TG_PROXY` (`socks5://...`) — весь трафик аккаунта идёт через этот
  SOCKS5-прокси (гео под клиента). Разбор строки — `parseProxy()`.
- Проверяет `isUserAuthorized()`. Если сессия «умерла» — процесс падает с понятной
  ошибкой (нужен повторный логин и новая `TG_SESSION`).
- Ставит публичный `@username` из `TG_USERNAME` (можно список через запятую —
  берётся первый свободный). Именно так меняется юзернейм аккаунта: правим
  `TG_USERNAME` в env → рестарт → код применяет через `account.UpdateUsername`.

### 3.2. Два способа получать входящие

**А) События (push)** — `client.addEventHandler(NewMessage({ incoming: true }))`.
Telegram сам присылает новые сообщения → `onEvent()` → `handleMessage()`.

**Б) Поллинг (fallback)** — включён `TG_POLLING=true`.
Иногда при подключении по прямому IP push-обновления не доходят, хотя аккаунт
может читать и отправлять. Поэтому каждые `TG_POLL_INTERVAL_MS` (по умолчанию
4000 мс) крутится `pollOnce()`:
- берёт последние диалоги (`getDialogs`),
- отбирает **личные** чаты с непрочитанными,
- вытаскивает непрочитанные сообщения, прогоняет **от старых к новым**,
- помечает как прочитанные (`markAsRead`).

При старте вызывается `seedLastSeen()` — запоминает текущие «верхние» id
сообщений, чтобы после запуска не переотвечать на старый бэклог.

### 3.3. `handleMessage()` — что происходит с каждым сообщением

1. Пропускает пустые (без текста).
2. **Только личка с людьми** (`TG_PRIVATE_ONLY=true`): не группы, не каналы, не
   другие боты, не свои же сообщения.
3. **Дедуп по id** через `lastSeen` (Map «чат → максимальный обработанный id») —
   чтобы событие и поллинг не обработали одно сообщение дважды.
4. Если гость **ответил (reply) на наше сообщение** (обычно на фото с подписью
   «адрес + цена») — код достаёт текст той цитаты (`quotedText`). Это позволяет
   агенту понять, на какую квартиру гость сказал «эту / давайте её».
5. Собирает объект `IncomingMessage` (`chatId`, `text`, `senderName`,
   `providerMessageId`, `timestamp`, `quotedText`) и передаёт в `Agent.handle`.

---

## 4. Агент: обработка хода

Файл: **[src/agent/agent.ts](../src/agent/agent.ts)** — класс `Agent`.

Шаги `handle(msg)`:

1. **Дедуп** по `chatId:providerMessageId` (на случай повторной доставки).
2. **Транскрипт** — входящее сразу пишется в durable-лог
   ([src/store/transcript.ts](../src/store/transcript.ts)), чтобы переписку можно
   было поднять даже после обрезки истории.
3. **Загрузка контекста чата** — `loadConversation(chatId)`
   ([src/store/conversations.ts](../src/store/conversations.ts)): история сообщений
   + `session` (в ней, например, `lastBookingId`). Контекст **персистится на диск**,
   поэтому рестарт/краш процесса не «сбрасывает» диалог и бот не здоровается заново.
4. Если было `quotedText` — подмешивает его в текст хода
   (`[в ответ на наше сообщение: "…"]`).
5. **Собирает инструменты** для этого хода — `buildTools(...)`
   ([src/agent/tools.ts](../src/agent/tools.ts)).
6. **Запускает ход модели** — `llm.runTurn({ systemPrompt, history, tools })`.
   Системный промпт (тон, воронка, политики) —
   [src/agent/prompt.ts](../src/agent/prompt.ts).
7. **Защита от зацикливания.** Если новый ответ слишком похож на один из двух
   предыдущих (Jaccard по словам с учётом чисел, порог `0.45`) — значит модель
   «застряла» на одной фразе. Тогда ответ подменяется на честную передачу
   администратору, а владельцу (`OWNER_CHAT_ID`) уходит предупреждение.
8. **Сохранение** — история (последние `MAX_HISTORY = 30`) + `session` пишутся
   обратно; исходящее пишется в транскрипт.
9. **Отправка** — `messenger.sendMessage(chatId, reply)`.

---

## 5. Цикл «модель ↔ инструменты»

Файл: **[src/llm/wavespeed.ts](../src/llm/wavespeed.ts)** — `WaveSpeedProvider`
(OpenAI-совместимый Chat Completions; модель из `WAVESPEED_MODEL`).

- Формирует массив сообщений: `system` + история.
- Отдаёт модели список инструментов (`tools`, `tool_choice: 'auto'`).
- Крутит цикл до `MAX_TOOL_HOPS = 6`:
  - модель отвечает **либо текстом** (цикл завершается — это финальный ответ),
  - **либо вызовом инструмента** → код выполняет `tool.handler(args)` и
    возвращает результат модели, цикл продолжается.
- Сетевые сбои: до 3 попыток, таймаут каждой 30 сек (короткий специально — в
  режиме поллинга ход блокирует весь бот, долгий зависший запрос заморозил бы
  всех).

### Инструменты агента (все в [src/agent/tools.ts](../src/agent/tools.ts))

| Инструмент               | Что делает |
|--------------------------|-----------|
| `check_availability`     | Свободно/занято + цена + мин. срок + метро/вместимость. Единственный источник цен и доступности. |
| `send_apartment_photos`  | Отправляет фото квартир альбомом (через messenger). |
| `apartment_amenities`    | Отвечает про удобства по описанию квартиры. |
| `get_apartment_info`     | Инфо/реквизиты/инструкция/правила по квартире. |
| `create_booking`         | Создаёт бронь в PMS. |
| `get_payment_link`       | Ссылка на оплату/залог. |
| `check_payment`          | Проверяет факт оплаты (не верит гостю на слово). |
| `confirm_checkout_time`  | Фиксирует названное гостем время выезда. |

Данные для инструментов берутся из **PMS-коннектора**. Какой именно PMS —
решается по владельцу: `createPmsForOwner(AGENT_OWNER_ID)`
([src/pms/for-owner.ts](../src/pms/for-owner.ts)) читает из БД `pms_provider` +
`pms_credentials` и строит нужный коннектор
([src/pms/realtycalendar.ts](../src/pms/realtycalendar.ts) или
[src/pms/bnovo.ts](../src/pms/bnovo.ts)). Когда `AGENT_OWNER_ID` задан, значение
`PMS_PROVIDER` из env **не** используется (см.
[src/index.ts](../src/index.ts) строки 50–52).

---

## 6. Отправка сообщений и защита аккаунта

Файл: **[src/messenger/telegram-user.ts](../src/messenger/telegram-user.ts)**.

### 6.1. Очередь отправки — `enqueueSend()`
Все исходящие идут через **один последовательный «конвейер»** с паузой ~3 сек
между отправками. Зачем: у аккаунтов (особенно свежих) строгие лимиты; пачка
сообщений/альбомов иначе ловит `FloodWaitError` и теряется. Если Telegram просит
подождать N секунд (`FloodWait`) — код ждёт (до 5 минут) и повторяет один раз,
вместо того чтобы потерять сообщение.

### 6.2. Текст — `sendMessage()`
Просто ставит `client.sendMessage` в очередь.

### 6.3. Фото — `sendPhotos()`
- Собирает **один альбом** (media group), максимум 10 фото.
- **Скачивает картинки сами** и грузит байтами: если отдать Telegram прямые
  URL (например, из Bnovo) для группы — он не успевает их забрать и падает с
  `MEDIA_INVALID`. Поэтому скачиваем → отправляем как файлы с подписью.

### 6.4. `hasNewerInbound()`
Проверяет «пришло ли от гостя новое сообщение, пока мы слали фото». Нужно, чтобы
не досылать пачку фото, если гость уже написал (например, уже выбрал квартиру).

### 6.5. Блокировка сессии — `SessionLock`
Файл: **[src/messenger/session-lock.ts](../src/messenger/session-lock.ts)**.

**Самое важное для безопасности аккаунта.** Если **два процесса** запустятся на
**одной и той же `TG_SESSION`**, Telegram аннулирует ключ авторизации
(`AUTH_KEY_DUPLICATED`) и **аккаунт умирает**. Защита:
- лок — это файл в temp, имя = хэш строки сессии (лок привязан к САМОЙ сессии, а
  не к процессу);
- создаётся атомарно (`O_CREAT|O_EXCL`);
- если лок есть, но его процесс мёртв (stale) — лок переехватывается;
- если лок держит живой процесс — новый процесс отказывается стартовать с понятной
  ошибкой.

> Важно: несколько РАЗНЫХ сессий (наш сервер + телефон клиента) сосуществуют
> нормально — это разные device-сессии одного аккаунта. Опасен только ДУБЛЬ одной
> и той же `TG_SESSION` в двух процессах.

---

## 7. Где что хранится (данные на диске)

Файл: **[src/store/paths.ts](../src/store/paths.ts)**.

- Каталог данных процесса: `DATA_DIR` из env, иначе `./data` рядом с кодом.
- Запись — **атомарная** (`writeJsonAtomic`: пишем во временный файл и
  переименовываем), чтобы краш/рестарт во время записи не оставил «рваный» JSON,
  который потом не распарсится и обнулит стор.
- Основные файлы:
  - `conversations.json` — история + `session` по каждому чату
    ([src/store/conversations.ts](../src/store/conversations.ts)),
  - контакты по броням ([src/store/booking-contacts.ts](../src/store/booking-contacts.ts)),
  - транскрипты переписок ([src/store/transcript.ts](../src/store/transcript.ts)),
  - фото — каталог `data/photos`, раздаётся по `/photos/:id/:file`
    (см. [src/index.ts](../src/index.ts)).

> ⚠️ **Внимание (текущее состояние):** `DATA_DIR` сейчас **не задан** ни в `.env`,
> ни в `.env.bnovo` — оба процесса пишут в общий `./data` и могут затирать файлы
> друг друга. Перед запуском третьего аккаунта нужно задать каждому процессу свой
> `DATA_DIR` (код это уже поддерживает — не хватает только значения в env).

---

## 8. Запуск и конфигурация

- Точка входа — **[src/index.ts](../src/index.ts)**: поднимает Fastify (health,
  раздача фото, admin/owner API), выбирает PMS и LLM, создаёт мессенджер и агент,
  запускает `messenger.init()`, планировщик хозяйственных задач
  ([src/housekeeping.ts](../src/housekeeping.ts)) и наблюдатель оплат
  ([src/payment-watcher.ts](../src/payment-watcher.ts)).
- Все переменные окружения объявлены и валидируются в
  **[src/config.ts](../src/config.ts)**.
- Процессы под pm2 — вручную с `DOTENV_CONFIG_PATH=<env-файл>` (ecosystem-конфиг
  [ecosystem.config.cjs](../ecosystem.config.cjs) описывает только базовый
  `ai-manager`).

### Ключевые переменные окружения (по группам)

**Telegram-аккаунт**
- `TG_API_ID`, `TG_API_HASH` — ключи приложения (my.telegram.org).
- `TG_SESSION` — строковая сессия (секрет; создаётся один раз при логине).
- `TG_USERNAME` — желаемый `@username` (список через запятую = кандидаты).
- `TG_PROXY` — `socks5://user:pass@host:port` (гео-прокси на аккаунт).
- `TG_POLLING` (`true`), `TG_POLL_INTERVAL_MS` (по умолч. 4000).
- `TG_PRIVATE_ONLY` (`true`) — отвечать только в личке живым людям.

**Мозги / данные**
- `MESSENGER=telegram-user` — режим живого аккаунта.
- `LLM_PROVIDER=wavespeed`, `WAVESPEED_MODEL`, `WAVESPEED_API_KEY`.
- `AGENT_OWNER_ID` — чей фонд ведёт этот процесс (PMS берётся из БД по нему).
- `DATA_DIR` — отдельный каталог данных на процесс (см. раздел 7).
- `OWNER_CHAT_ID` — куда слать эскалации (например, при зацикливании).

---

## 9. Карта файлов

| Слой                  | Файл |
|-----------------------|------|
| Точка входа           | [src/index.ts](../src/index.ts) |
| Конфиг / env          | [src/config.ts](../src/config.ts) |
| Живой TG-аккаунт      | [src/messenger/telegram-user.ts](../src/messenger/telegram-user.ts) |
| Блокировка сессии     | [src/messenger/session-lock.ts](../src/messenger/session-lock.ts) |
| Интерфейс мессенджера | [src/messenger/types.ts](../src/messenger/types.ts) |
| Агент (ход диалога)   | [src/agent/agent.ts](../src/agent/agent.ts) |
| Системный промпт      | [src/agent/prompt.ts](../src/agent/prompt.ts) |
| Инструменты агента    | [src/agent/tools.ts](../src/agent/tools.ts) |
| LLM (цикл инструментов)| [src/llm/wavespeed.ts](../src/llm/wavespeed.ts) |
| Выбор PMS по владельцу| [src/pms/for-owner.ts](../src/pms/for-owner.ts) |
| PMS: RealtyCalendar   | [src/pms/realtycalendar.ts](../src/pms/realtycalendar.ts) |
| PMS: Bnovo            | [src/pms/bnovo.ts](../src/pms/bnovo.ts) |
| Хранилище диалогов    | [src/store/conversations.ts](../src/store/conversations.ts) |
| Пути/атомарная запись | [src/store/paths.ts](../src/store/paths.ts) |
| Транскрипты           | [src/store/transcript.ts](../src/store/transcript.ts) |
| Наблюдатель оплат     | [src/payment-watcher.ts](../src/payment-watcher.ts) |
| Хозяйственные задачи  | [src/housekeeping.ts](../src/housekeeping.ts) |
