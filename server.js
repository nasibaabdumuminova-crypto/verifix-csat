const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123';
const USE_DB = !!process.env.DATABASE_URL;

// Storage abstraction: PostgreSQL in production, in-memory fallback for local preview.
let pool = null;
const memStore = { reviews: [], nextId: 1 };

if (USE_DB) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('railway') || process.env.PGSSL === 'true'
      ? { rejectUnauthorized: false }
      : false,
  });
}

async function initDb() {
  if (!USE_DB) {
    console.log('No DATABASE_URL — using in-memory storage (preview mode)');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id SERIAL PRIMARY KEY,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('DB ready');
}

async function insertReview(rating, comment) {
  if (USE_DB) {
    await pool.query('INSERT INTO reviews (rating, comment) VALUES ($1, $2)', [rating, comment]);
  } else {
    memStore.reviews.unshift({
      id: memStore.nextId++,
      rating,
      comment,
      created_at: new Date().toISOString(),
    });
  }
}

async function getReviews() {
  if (USE_DB) {
    const list = await pool.query(
      'SELECT id, rating, comment, created_at FROM reviews ORDER BY created_at DESC'
    );
    const avg = await pool.query(
      'SELECT COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS avg, COUNT(*) AS total FROM reviews'
    );
    return {
      avg: parseFloat(avg.rows[0].avg),
      total: parseInt(avg.rows[0].total, 10),
      reviews: list.rows,
    };
  }
  const total = memStore.reviews.length;
  const avg = total
    ? Math.round((memStore.reviews.reduce((s, r) => s + r.rating, 0) / total) * 100) / 100
    : 0;
  return { avg, total, reviews: memStore.reviews };
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Public submission endpoint
app.post('/api/reviews', async (req, res) => {
  try {
    const rating = parseInt(req.body.rating, 10);
    const comment = (req.body.comment || '').toString().slice(0, 2000);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Оценка должна быть от 1 до 5' });
    }
    await insertReview(rating, comment || null);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Admin auth helper
function checkAuth(req) {
  const pwd = req.query.password || req.headers['x-admin-password'];
  return pwd === ADMIN_PASSWORD;
}

// Admin API — fetch reviews + avg
app.get('/api/admin/reviews', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Неверный пароль' });
  try {
    res.json(await getReviews());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Admin page (HTML served from /public/admin.html)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Healthcheck
app.get('/healthz', (req, res) => res.send('ok'));

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`CSAT Radar listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('DB init failed:', err);
    process.exit(1);
  });
