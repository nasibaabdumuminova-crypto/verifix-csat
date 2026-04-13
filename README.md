# Verifix CSAT Radar

Пульт сбора оценок — публичная форма с 5 звёздами + админ-панель со средним баллом.

## Стек
- Node.js + Express
- PostgreSQL (`pg`)
- Vanilla HTML/CSS/JS (без сборки)

## Локальный запуск

```bash
npm install
cp .env.example .env   # отредактируйте DATABASE_URL
npm start
```

Откройте:
- `http://localhost:3000/` — публичная страница оценки
- `http://localhost:3000/admin` — админ-панель (пароль по умолчанию `123`)

Таблица `reviews` создаётся автоматически при старте.

## Деплой на Railway

1. Зайдите на [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** (или **Empty Project** + загрузка кода через `railway up`).
2. В проекте нажмите **+ New** → **Database** → **Add PostgreSQL**. Railway автоматически прокинет переменную `DATABASE_URL` в ваш сервис.
3. (Опционально) В **Variables** добавьте `ADMIN_PASSWORD` — иначе будет `123`.
4. Railway сам соберёт по `railway.json` (Nixpacks → `npm install` → `npm start`).
5. В **Settings** сервиса включите **Generate Domain** — получите публичную ссылку.

Готово: ссылку для клиентов рассылаете на корень `/`, админка — `/admin`.

## Структура
```
.
├── server.js          # Express + PG + API
├── package.json
├── railway.json       # конфиг деплоя
├── public/
│   ├── index.html     # публичная страница (звёзды + комментарий)
│   ├── admin.html     # админ-панель
│   └── style.css      # стили в палитре Verifix
└── .env.example
```
