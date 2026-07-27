# Кабинет квартир — админка (Vercel)

Простая панель для арендодателя: войти по паролю → выбрать квартиру (список тянется
из Realty Calendar) → заполнить правила проживания, инструкцию по заселению, Wi‑Fi.
Данные сохраняются на сервере агента и отдаются гостям.

Общение с гостями остаётся в Telegram — этот сайт **только** для заполнения контента.

## Как задеплоить на Vercel

1. Импортируй репозиторий в Vercel и в настройках проекта укажи **Root Directory = `admin-web`**
   (это подпапка монорепо, не корень).
2. Framework Preset определится как **Next.js** автоматически.
3. Добавь Environment Variable:
   - `NEXT_PUBLIC_API_BASE` = `http://178.88.115.213/api/admin`
     (или `https://<домен>/api/admin`, когда повесишь домен/SSL на сервер).
4. Deploy.

## Как войти

Пароль = `ADMIN_TOKEN` из `.env` агента на сервере. Узнать текущий:
```bash
grep ADMIN_TOKEN /opt/ai-manager/.env
```

## Локальный запуск

```bash
cd admin-web
cp .env.local.example .env.local   # проверь NEXT_PUBLIC_API_BASE
npm install
npm run dev
```

## Заметки по безопасности

- Пока `ADMIN_CORS_ORIGIN=*` на сервере. После деплоя на Vercel желательно
  сузить до конкретного origin (домен Vercel) в `.env` агента.
- API сейчас по HTTP (IP без домена). Для продакшна повесить домен + SSL (certbot),
  тогда `NEXT_PUBLIC_API_BASE` станет `https://…`.
