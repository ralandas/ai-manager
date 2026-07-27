# Кабинет квартир — админка

Панель для арендодателя: войти по паролю → выбрать квартиру (список из Realty
Calendar) → заполнить правила проживания, инструкцию по заселению, Wi‑Fi,
загрузить фото. Данные и фото уходят на сервер агента и отдаются гостям.
Общение с гостями — в Telegram; этот сайт только для заполнения контента.

## Деплой на Netlify (бесплатно, бессрочно, без карты)

1. netlify.com → Add new site → Import from GitHub → репозиторий `ai-manager`.
2. Настройки сборки:
   - **Base directory:** `admin-web`
   - **Build command:** `npm run build`
   - **Publish directory:** `admin-web/out`
   (Всё это уже прописано в `netlify.toml`, Netlify подхватит автоматически.)
3. Deploy. Готово — сайт на `https://<имя>.netlify.app`.

### Почему работает без домена и SSL на сервере

API агента живёт на VPS по **http**. Открывать его напрямую с https-сайта нельзя
(mixed-content). Поэтому `netlify.toml` **проксирует** `/api/*` и `/photos/*` на
`http://178.88.115.213` на стороне Netlify — браузер видит только https Netlify.
Менять код не нужно; фронт зовёт относительный `/api/admin`.

Если сменится IP/домен сервера — поправь адреса в `netlify.toml`.

## Вход

Пароль = `ADMIN_TOKEN` из `.env` агента на сервере:
```bash
grep ADMIN_TOKEN /opt/ai-manager/.env
```

## Локальный запуск

```bash
cd admin-web
npm install
npm run dev          # NEXT_PUBLIC_API_BASE по умолчанию /api/admin
```
Для локалки, если нужен прямой доступ к API, создай `.env.local`:
```
NEXT_PUBLIC_API_BASE=http://178.88.115.213/api/admin
```

## Что редактируется по каждой квартире

Адрес · фото (бот шлёт их гостю с подписью «название + цена») · как заселиться ·
правила проживания · Wi‑Fi · дополнительно.
