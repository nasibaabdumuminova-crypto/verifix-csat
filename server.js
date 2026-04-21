const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123';
const USE_DB = !!process.env.DATABASE_URL;

// Storage abstraction: PostgreSQL in production, in-memory fallback for local preview.
let pool = null;
const memStore = {
  reviews: [],
  nextReviewId: 1,
  questions: [],
  nextQuestionId: 1,
  responses: [],
  nextResponseId: 1,
  answers: [],
  nextAnswerId: 1,
};

if (USE_DB) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('railway') || process.env.PGSSL === 'true'
      ? { rejectUnauthorized: false }
      : false,
  });
}

// ========================================================================
// SEED DATA — initial 39 questions (from Verifix Google Form v2)
// Loaded from seed_questions.json so Python preview server can share the same source.
// ========================================================================
const SEED_QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed_questions.json'), 'utf-8'));

// ========================================================================
// DB INIT
// ========================================================================
async function initDb() {
  if (!USE_DB) {
    console.log('No DATABASE_URL — using in-memory storage (preview mode)');
    seedMemoryQuestions();
    return;
  }
  // Legacy reviews table (unchanged)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id SERIAL PRIMARY KEY,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Survey tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS survey_questions (
      id SERIAL PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      section_number INT NOT NULL,
      section_title TEXT NOT NULL,
      section_help TEXT,
      position INT NOT NULL,
      title TEXT NOT NULL,
      help_text TEXT,
      type TEXT NOT NULL CHECK (type IN ('short_text','long_text','radio','checkbox','scale')),
      required BOOLEAN NOT NULL DEFAULT FALSE,
      config JSONB,
      show_if JSONB,
      deleted_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS survey_responses (
      id SERIAL PRIMARY KEY,
      company_name TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS survey_answers (
      id SERIAL PRIMARY KEY,
      response_id INT NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
      question_id INT REFERENCES survey_questions(id) ON DELETE SET NULL,
      question_key TEXT NOT NULL,
      value JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_answers_response ON survey_answers(response_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_answers_qkey ON survey_answers(question_key);`);

  // Seed questions if empty
  const countRow = await pool.query('SELECT COUNT(*) AS c FROM survey_questions WHERE deleted_at IS NULL');
  if (parseInt(countRow.rows[0].c, 10) === 0) {
    for (const q of SEED_QUESTIONS) {
      await pool.query(
        `INSERT INTO survey_questions (key, section_number, section_title, section_help, position, title, help_text, type, required, config, show_if)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (key) DO NOTHING`,
        [q.key, q.section_number, q.section_title, q.section_help || null, q.position, q.title,
         q.help_text || null, q.type, !!q.required,
         q.config ? JSON.stringify(q.config) : null,
         q.show_if ? JSON.stringify(q.show_if) : null]
      );
    }
    console.log(`Seeded ${SEED_QUESTIONS.length} survey questions`);
  }
  console.log('DB ready');
}

function seedMemoryQuestions() {
  if (memStore.questions.length) return;
  for (const q of SEED_QUESTIONS) {
    memStore.questions.push({
      id: memStore.nextQuestionId++,
      key: q.key,
      section_number: q.section_number,
      section_title: q.section_title,
      section_help: q.section_help || null,
      position: q.position,
      title: q.title,
      help_text: q.help_text || null,
      type: q.type,
      required: !!q.required,
      config: q.config || null,
      show_if: q.show_if || null,
      deleted_at: null,
    });
  }
}

// ========================================================================
// DATA ACCESS
// ========================================================================
async function getAllQuestions({ includeDeleted = false } = {}) {
  if (USE_DB) {
    const sql = includeDeleted
      ? 'SELECT * FROM survey_questions ORDER BY section_number, position, id'
      : 'SELECT * FROM survey_questions WHERE deleted_at IS NULL ORDER BY section_number, position, id';
    const r = await pool.query(sql);
    return r.rows;
  }
  return memStore.questions
    .filter((q) => includeDeleted || !q.deleted_at)
    .sort((a, b) => a.section_number - b.section_number || a.position - b.position || a.id - b.id);
}

async function createQuestion(q) {
  if (USE_DB) {
    const r = await pool.query(
      `INSERT INTO survey_questions (key, section_number, section_title, section_help, position, title, help_text, type, required, config, show_if)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [q.key, q.section_number, q.section_title, q.section_help || null, q.position, q.title,
       q.help_text || null, q.type, !!q.required,
       q.config ? JSON.stringify(q.config) : null,
       q.show_if ? JSON.stringify(q.show_if) : null]
    );
    return r.rows[0];
  }
  const row = { id: memStore.nextQuestionId++, deleted_at: null, ...q };
  memStore.questions.push(row);
  return row;
}

async function updateQuestion(id, q) {
  if (USE_DB) {
    const r = await pool.query(
      `UPDATE survey_questions SET
         key=COALESCE($2, key),
         section_number=COALESCE($3, section_number),
         section_title=COALESCE($4, section_title),
         section_help=$5,
         position=COALESCE($6, position),
         title=COALESCE($7, title),
         help_text=$8,
         type=COALESCE($9, type),
         required=COALESCE($10, required),
         config=$11,
         show_if=$12
       WHERE id=$1 RETURNING *`,
      [id, q.key, q.section_number, q.section_title, q.section_help ?? null,
       q.position, q.title, q.help_text ?? null, q.type, q.required,
       q.config ? JSON.stringify(q.config) : null,
       q.show_if ? JSON.stringify(q.show_if) : null]
    );
    return r.rows[0];
  }
  const row = memStore.questions.find((x) => x.id === id);
  if (!row) return null;
  Object.assign(row, q);
  return row;
}

async function deleteQuestion(id) {
  if (USE_DB) {
    await pool.query('UPDATE survey_questions SET deleted_at=NOW() WHERE id=$1', [id]);
    return;
  }
  const row = memStore.questions.find((x) => x.id === id);
  if (row) row.deleted_at = new Date().toISOString();
}

async function insertResponse({ company_name, email, answers }) {
  if (USE_DB) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        'INSERT INTO survey_responses (company_name, email) VALUES ($1, $2) RETURNING id, created_at',
        [company_name, email]
      );
      const respId = r.rows[0].id;
      for (const a of answers) {
        await client.query(
          `INSERT INTO survey_answers (response_id, question_id, question_key, value)
           VALUES ($1, $2, $3, $4)`,
          [respId, a.question_id, a.question_key, JSON.stringify(a.value)]
        );
      }
      await client.query('COMMIT');
      return { id: respId, created_at: r.rows[0].created_at };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  const resp = {
    id: memStore.nextResponseId++,
    company_name, email,
    created_at: new Date().toISOString(),
  };
  memStore.responses.unshift(resp);
  for (const a of answers) {
    memStore.answers.push({
      id: memStore.nextAnswerId++,
      response_id: resp.id,
      question_id: a.question_id,
      question_key: a.question_key,
      value: a.value,
      created_at: resp.created_at,
    });
  }
  return { id: resp.id, created_at: resp.created_at };
}

async function getAllResponses() {
  if (USE_DB) {
    const resp = await pool.query('SELECT * FROM survey_responses ORDER BY created_at DESC');
    const answers = await pool.query('SELECT * FROM survey_answers');
    const byResp = {};
    for (const a of answers.rows) {
      const v = a.value;
      (byResp[a.response_id] = byResp[a.response_id] || []).push({
        question_id: a.question_id,
        question_key: a.question_key,
        value: v,
      });
    }
    return resp.rows.map((r) => ({ ...r, answers: byResp[r.id] || [] }));
  }
  return memStore.responses.map((r) => ({
    ...r,
    answers: memStore.answers
      .filter((a) => a.response_id === r.id)
      .map((a) => ({ question_id: a.question_id, question_key: a.question_key, value: a.value })),
  }));
}

// Legacy reviews
async function insertReview(rating, comment) {
  if (USE_DB) {
    await pool.query('INSERT INTO reviews (rating, comment) VALUES ($1, $2)', [rating, comment]);
  } else {
    memStore.reviews.unshift({
      id: memStore.nextReviewId++, rating, comment,
      created_at: new Date().toISOString(),
    });
  }
}

async function getReviews() {
  if (USE_DB) {
    const list = await pool.query('SELECT id, rating, comment, created_at FROM reviews ORDER BY created_at DESC');
    const avg = await pool.query('SELECT COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS avg, COUNT(*) AS total FROM reviews');
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

// ========================================================================
// STATS (computed in JS from responses)
// ========================================================================
function computeStats(responses) {
  const totalResponses = responses.length;
  const valByKey = (key) => responses
    .map((r) => r.answers.find((a) => a.question_key === key))
    .filter(Boolean)
    .map((a) => a.value);

  // NPS
  const npsValues = valByKey('nps').map(Number).filter((v) => Number.isFinite(v));
  const prom = npsValues.filter((v) => v >= 9).length;
  const det = npsValues.filter((v) => v <= 6).length;
  const neu = npsValues.length - prom - det;
  const npsScore = npsValues.length ? Math.round((prom - det) / npsValues.length * 100) : null;

  // CSAT
  const avg = (arr) => arr.length ? +(arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(2) : null;
  const csatProduct = avg(valByKey('csat_product').map(Number).filter(Number.isFinite));
  const csatService = avg(valByKey('csat_service').map(Number).filter(Number.isFinite));

  // Other scale averages
  const scales = {};
  for (const key of ['interface_score', 'support_speed', 'support_quality', 'manager_score']) {
    scales[key] = avg(valByKey(key).map(Number).filter(Number.isFinite));
  }

  // Distributions for key categorical
  const distribution = (key) => {
    const out = {};
    for (const v of valByKey(key)) {
      const k = Array.isArray(v) ? '—' : String(v);
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  };

  return {
    totalResponses,
    nps: { score: npsScore, promoters: prom, neutrals: neu, detractors: det, count: npsValues.length },
    csatProduct,
    csatService,
    scales,
    distributions: {
      roi_category: distribution('roi_category'),
      renewal_intent: distribution('renewal_intent'),
      alternatives: distribution('alternatives'),
      bug_frequency: distribution('bug_frequency'),
    },
  };
}

// ========================================================================
// MIDDLEWARE
// ========================================================================
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function checkAuth(req) {
  const pwd = req.query.password || req.headers['x-admin-password'] || (req.body && req.body.password);
  return pwd === ADMIN_PASSWORD;
}
function requireAuth(req, res, next) {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Неверный пароль' });
  next();
}

// ========================================================================
// LEGACY REVIEWS API
// ========================================================================
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

app.get('/api/admin/reviews', requireAuth, async (req, res) => {
  try { res.json(await getReviews()); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ========================================================================
// SURVEY PUBLIC API
// ========================================================================
app.get('/api/survey/questions', async (req, res) => {
  try {
    const qs = await getAllQuestions();
    res.json({ questions: qs });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/survey/responses', async (req, res) => {
  try {
    const { company_name, email, answers } = req.body || {};
    if (!company_name || !String(company_name).trim()) {
      return res.status(400).json({ error: 'Укажите название компании' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return res.status(400).json({ error: 'Укажите корректный email' });
    }
    if (!Array.isArray(answers)) {
      return res.status(400).json({ error: 'Некорректный формат ответов' });
    }

    // Validate required questions answered
    const questions = await getAllQuestions();
    const answerMap = new Map();
    for (const a of answers) {
      if (a && a.question_key) answerMap.set(a.question_key, a.value);
    }
    for (const q of questions) {
      if (!q.required) continue;
      // Skip required check if the question is hidden by show_if
      if (q.show_if) {
        const triggerVal = answerMap.get(q.show_if.question_key);
        const isVisible = Array.isArray(q.show_if.values) && q.show_if.values.includes(triggerVal);
        if (!isVisible) continue;
      }
      const v = answerMap.get(q.key);
      const empty = v === undefined || v === null || v === '' ||
                    (Array.isArray(v) && v.length === 0);
      if (empty) {
        return res.status(400).json({ error: `Ответьте на обязательный вопрос: «${q.title}»` });
      }
    }

    // Build ordered answer rows
    const byKey = new Map(questions.map((q) => [q.key, q]));
    const rows = [];
    for (const a of answers) {
      if (!a || !a.question_key) continue;
      const q = byKey.get(a.question_key);
      if (!q) continue;
      rows.push({ question_id: q.id, question_key: q.key, value: a.value });
    }

    const result = await insertResponse({
      company_name: String(company_name).trim().slice(0, 200),
      email: String(email).trim().toLowerCase().slice(0, 200),
      answers: rows,
    });
    res.json({ ok: true, id: result.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ========================================================================
// SURVEY ADMIN API
// ========================================================================
app.get('/api/admin/survey/stats', requireAuth, async (req, res) => {
  try {
    const responses = await getAllResponses();
    res.json(computeStats(responses));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/admin/survey/responses', requireAuth, async (req, res) => {
  try {
    const [responses, questions] = await Promise.all([getAllResponses(), getAllQuestions({ includeDeleted: true })]);
    res.json({ responses, questions });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/admin/survey/questions', requireAuth, async (req, res) => {
  try {
    const qs = await getAllQuestions({ includeDeleted: false });
    res.json({ questions: qs });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/admin/survey/questions', requireAuth, async (req, res) => {
  try {
    const q = req.body || {};
    if (!q.key || !q.title || !q.type || !q.section_number || !q.section_title) {
      return res.status(400).json({ error: 'Заполните ключ, заголовок, тип, номер и название секции' });
    }
    const row = await createQuestion({
      key: String(q.key).trim(),
      section_number: parseInt(q.section_number, 10),
      section_title: String(q.section_title),
      section_help: q.section_help || null,
      position: q.position ? parseInt(q.position, 10) : 99,
      title: String(q.title),
      help_text: q.help_text || null,
      type: q.type,
      required: !!q.required,
      config: q.config || null,
      show_if: q.show_if || null,
    });
    res.json({ ok: true, question: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Ошибка сервера' });
  }
});

app.put('/api/admin/survey/questions/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const q = req.body || {};
    const row = await updateQuestion(id, {
      key: q.key,
      section_number: q.section_number != null ? parseInt(q.section_number, 10) : undefined,
      section_title: q.section_title,
      section_help: q.section_help,
      position: q.position != null ? parseInt(q.position, 10) : undefined,
      title: q.title,
      help_text: q.help_text,
      type: q.type,
      required: q.required,
      config: q.config,
      show_if: q.show_if,
    });
    if (!row) return res.status(404).json({ error: 'Вопрос не найден' });
    res.json({ ok: true, question: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Ошибка сервера' });
  }
});

app.delete('/api/admin/survey/questions/:id', requireAuth, async (req, res) => {
  try {
    await deleteQuestion(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// CSV export
app.get('/api/admin/survey/export.csv', requireAuth, async (req, res) => {
  try {
    const [responses, questions] = await Promise.all([getAllResponses(), getAllQuestions({ includeDeleted: true })]);
    const cols = ['id', 'created_at', 'company_name', 'email', ...questions.map((q) => q.key)];
    const escape = (s) => {
      if (s === null || s === undefined) return '';
      const str = Array.isArray(s) ? s.join(' | ') : String(s);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const lines = [cols.join(',')];
    for (const r of responses) {
      const byKey = new Map(r.answers.map((a) => [a.question_key, a.value]));
      const row = [r.id, r.created_at, r.company_name, r.email, ...questions.map((q) => escape(byKey.get(q.key)))];
      lines.push(row.map((x) => (typeof x === 'string' && x.startsWith('"') ? x : escape(x))).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="verifix_survey.csv"');
    res.send('\uFEFF' + lines.join('\n'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ========================================================================
// PAGES
// ========================================================================
app.get('/survey', (req, res) => res.sendFile(path.join(__dirname, 'public', 'survey.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/survey', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-survey.html')));

app.get('/healthz', (req, res) => res.send('ok'));

initDb()
  .then(() => app.listen(PORT, () => console.log(`Verifix app listening on :${PORT}`)))
  .catch((err) => { console.error('DB init failed:', err); process.exit(1); });
