# Деплой Verifix CSAT Radar на Railway

## Что готово в репозитории
- `server.js` — Express + PostgreSQL, авто-создаёт таблицу `reviews` при старте
- `package.json` — зависимости, `npm start`, Node 18+
- `railway.json` — конфиг билда (Nixpacks) и healthcheck `/healthz`
- `Procfile` — на случай, если Railway проигнорирует railway.json
- `.nvmrc` — версия Node (20)
- `public/` — фронтенд (index.html, admin.html, style.css, logo.png)

## Способ 1: GitHub → Railway (рекомендую)

### 1. Создайте GitHub-репозиторий
Зайдите на https://github.com/new, создайте пустой репо (например `verifix-csat`), **без** README/`.gitignore`.

### 2. Загрузите код
В терминале (PowerShell) из папки проекта:
```bash
cd C:\Users\Verifix\Documents\claude
git init
git add .
git commit -m "Initial commit: Verifix CSAT Radar"
git branch -M main
git remote add origin https://github.com/<ВАШ_ЛОГИН>/verifix-csat.git
git push -u origin main
```

### 3. Подключите к Railway
1. https://railway.app → **New Project** → **Deploy from GitHub repo** → выберите `verifix-csat`.
2. Railway автоматически запустит билд по `railway.json` (Nixpacks → `npm install` → `npm start`).
3. В этом же проекте: **+ New** → **Database** → **Add PostgreSQL**.  
   Railway автоматически прокинет переменную `DATABASE_URL` в ваш сервис.
4. (Опционально) Settings сервиса → **Variables** → добавьте `ADMIN_PASSWORD` (иначе будет `123`).
5. Settings → **Networking** → **Generate Domain** → получите публичный URL вида `https://verifix-csat-production.up.railway.app`.

### 4. Проверка
- Публичная форма: `https://<ваш-домен>/`
- Админка: `https://<ваш-домен>/admin` (пароль `123` или ваш `ADMIN_PASSWORD`)
- Healthcheck: `https://<ваш-домен>/healthz` → `ok`

Ссылку из п. 4 (публичную) рассылаете клиентам.

---

## Способ 2: Railway CLI (без GitHub)

```bash
npm install -g @railway/cli
railway login
cd C:\Users\Verifix\Documents\claude
railway init           # создать новый проект
railway add            # добавить PostgreSQL plugin
railway up             # задеплоить
railway domain         # получить публичный URL
```

Чтобы задать пароль админа:
```bash
railway variables set ADMIN_PASSWORD=ваш_пароль
```

---

## Переменные окружения

| Имя | Обязательна | Описание |
|---|---|---|
| `DATABASE_URL` | да (на Railway — авто) | Строка подключения к PostgreSQL |
| `ADMIN_PASSWORD` | нет (default `123`) | Пароль для `/admin` |
| `PORT` | нет (Railway задаёт сам) | Порт сервера |

## Безопасность
- Перед запуском в проде **обязательно** смените `ADMIN_PASSWORD` на длинный пароль.
- Если данные критичны — рассмотрите добавление полноценной аутентификации (JWT/cookie вместо пароля в URL).
