const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
// Trim the password in case the env-var value was pasted into Railway
// with a stray newline or leading/trailing space — that used to lock
// the operator out of /admin/survey with a correct-looking password.
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '123').trim();

// Temporary recovery password — operator is locked out of admin and
// the Railway env-var value isn't matching what they think it is.
// This always works in addition to ADMIN_PASSWORD until removed.
// To remove: delete this constant and the OR-check in checkAuth() below,
// then commit. Hardcoded value is intentionally NOT secret-grade.
const ADMIN_PASSWORD_RECOVERY = 'verifix-admin-26';
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
// SEED DATA — loaded from seed_questions.json (trilingual)
// ========================================================================
const SEED_QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed_questions.json'), 'utf-8'));
const LANGS = ['ru', 'uz_cyr', 'uz_lat'];
const DEFAULT_LANG = 'ru';

// Helper: safely extract a localized string
function tr(x, lang) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  return x[lang] || x[DEFAULT_LANG] || x.ru || Object.values(x)[0] || '';
}

// Phone validator: must contain +998 and at least 9 additional digits (12 total)
function isPhoneValid(p) {
  const digits = (p || '').replace(/\D/g, '');
  return digits.startsWith('998') && digits.length >= 12;
}

// ========================================================================
// DB INIT + MIGRATION
// ========================================================================
async function initDb() {
  if (!USE_DB) {
    console.log('No DATABASE_URL — using in-memory storage (preview mode)');
    seedMemoryQuestions();
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

  // Check if old v1 schema exists (has `section_number` column instead of `step_number`).
  // If so, drop all survey_* tables and recreate with new schema.
  const oldSchema = await pool.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'survey_questions' AND column_name IN ('section_number','step_number')
  `);
  const hasOld = oldSchema.rows.some((r) => r.column_name === 'section_number');
  const hasNew = oldSchema.rows.some((r) => r.column_name === 'step_number');
  if (hasOld && !hasNew) {
    console.log('Migrating survey tables from v1 (section_number) to v9 (step_number, i18n)…');
    await pool.query('DROP TABLE IF EXISTS survey_answers CASCADE');
    await pool.query('DROP TABLE IF EXISTS survey_responses CASCADE');
    await pool.query('DROP TABLE IF EXISTS survey_questions CASCADE');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS survey_questions (
      id SERIAL PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      step_number INT NOT NULL,
      step_title JSONB NOT NULL,
      step_help JSONB,
      position INT NOT NULL,
      title JSONB NOT NULL,
      help_text JSONB,
      type TEXT NOT NULL CHECK (type IN ('short_text','long_text','radio','checkbox','scale','select')),
      required BOOLEAN NOT NULL DEFAULT FALSE,
      config JSONB,
      show_if JSONB,
      deleted_at TIMESTAMPTZ
    );
  `);
  // Ensure 'select' is allowed on existing installs (one-time migration)
  try {
    await pool.query(`ALTER TABLE survey_questions DROP CONSTRAINT IF EXISTS survey_questions_type_check`);
    await pool.query(`ALTER TABLE survey_questions ADD CONSTRAINT survey_questions_type_check CHECK (type IN ('short_text','long_text','radio','checkbox','scale','select'))`);
  } catch (_) { /* ignore */ }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS survey_responses (
      id SERIAL PRIMARY KEY,
      company_name TEXT NOT NULL,
      contact_name TEXT,
      position TEXT,
      phone TEXT,
      language TEXT NOT NULL DEFAULT 'ru',
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
        `INSERT INTO survey_questions (key, step_number, step_title, step_help, position, title, help_text, type, required, config, show_if)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (key) DO NOTHING`,
        [
          q.key, q.step_number,
          JSON.stringify(q.step_title), q.step_help ? JSON.stringify(q.step_help) : null,
          q.position,
          JSON.stringify(q.title), q.help_text ? JSON.stringify(q.help_text) : null,
          q.type, !!q.required,
          q.config ? JSON.stringify(q.config) : null,
          q.show_if ? JSON.stringify(q.show_if) : null,
        ]
      );
    }
    console.log(`Seeded ${SEED_QUESTIONS.length} survey questions (v9 trilingual)`);
  }

  // Idempotent post-seed sync: seed is the source of truth for built-in
  // questions. On every boot we (1) INSERT new seed keys that aren't in DB,
  // (2) UPDATE existing rows where any seed field drifted, (3) soft-delete
  // any previously-seeded rows whose key was removed from seed (e.g.
  // nps_like / nps_improve removed in favor of nps_range_* segments).
  //
  // 1) INSERT missing seed questions.
  let inserted = 0;
  for (const q of SEED_QUESTIONS) {
    const r = await pool.query(
      `INSERT INTO survey_questions (key, step_number, step_title, step_help, position, title, help_text, type, required, config, show_if)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (key) DO NOTHING RETURNING id`,
      [
        q.key, q.step_number,
        JSON.stringify(q.step_title), q.step_help ? JSON.stringify(q.step_help) : null,
        q.position,
        JSON.stringify(q.title), q.help_text ? JSON.stringify(q.help_text) : null,
        q.type, !!q.required,
        q.config ? JSON.stringify(q.config) : null,
        q.show_if ? JSON.stringify(q.show_if) : null,
      ]
    );
    inserted += r.rowCount;
  }
  if (inserted) console.log(`Post-seed sync: inserted ${inserted} new question(s) from seed`);

  // 2) UPDATE drifted rows.
  let migrated = 0;
  for (const q of SEED_QUESTIONS) {
    const r = await pool.query(
      `UPDATE survey_questions
         SET type = $1,
             config = $2::jsonb,
             help_text = $3::jsonb,
             title = $4::jsonb,
             step_title = $5::jsonb,
             step_help = $6::jsonb,
             show_if = $7::jsonb,
             required = $8,
             position = $9,
             step_number = $10
       WHERE key = $11 AND deleted_at IS NULL AND (
         type <> $1 OR
         config IS DISTINCT FROM $2::jsonb OR
         help_text IS DISTINCT FROM $3::jsonb OR
         title IS DISTINCT FROM $4::jsonb OR
         step_title IS DISTINCT FROM $5::jsonb OR
         step_help IS DISTINCT FROM $6::jsonb OR
         show_if IS DISTINCT FROM $7::jsonb OR
         required IS DISTINCT FROM $8 OR
         position IS DISTINCT FROM $9 OR
         step_number IS DISTINCT FROM $10
       )
       RETURNING id`,
      [
        q.type,
        q.config ? JSON.stringify(q.config) : null,
        q.help_text ? JSON.stringify(q.help_text) : null,
        JSON.stringify(q.title),
        JSON.stringify(q.step_title),
        q.step_help ? JSON.stringify(q.step_help) : null,
        q.show_if ? JSON.stringify(q.show_if) : null,
        !!q.required,
        q.position,
        q.step_number,
        q.key,
      ]
    );
    migrated += r.rowCount;
  }
  if (migrated) console.log(`Post-seed sync: updated ${migrated} question(s) from seed`);

  // 3) Soft-delete keys that the seed no longer contains. We keep rows so that
  // historical answers referencing them stay readable. Admin-created custom
  // questions never get deleted because they're never seeded — this tracks
  // a known set of keys via a sentinel prefix table.
  //
  // Safe heuristic: only auto-retire keys that were once in a seed (we can't
  // know this without a registry, so we limit removals to the explicit list
  // of retired keys below).
  // Keys that existed in an earlier seed but have been removed since.
  // They stay in the DB (soft-deleted) so historical responses keep their
  // reference integrity, but they won't be served to the survey UI.
  const RETIRED_KEYS = ['nps_like', 'nps_improve', 'retention_reason'];
  if (RETIRED_KEYS.length) {
    const r = await pool.query(
      `UPDATE survey_questions
         SET deleted_at = NOW()
       WHERE key = ANY($1::text[])
         AND deleted_at IS NULL
       RETURNING key`,
      [RETIRED_KEYS]
    );
    if (r.rowCount) console.log(`Post-seed sync: soft-deleted retired keys: ${r.rows.map(x=>x.key).join(', ')}`);
  }

  console.log('DB ready');
}

function seedMemoryQuestions() {
  if (memStore.questions.length) return;
  for (const q of SEED_QUESTIONS) {
    memStore.questions.push({
      id: memStore.nextQuestionId++,
      key: q.key,
      step_number: q.step_number,
      step_title: q.step_title,
      step_help: q.step_help || null,
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
      ? 'SELECT * FROM survey_questions ORDER BY step_number, position, id'
      : 'SELECT * FROM survey_questions WHERE deleted_at IS NULL ORDER BY step_number, position, id';
    const r = await pool.query(sql);
    return r.rows;
  }
  return memStore.questions
    .filter((q) => includeDeleted || !q.deleted_at)
    .sort((a, b) => a.step_number - b.step_number || a.position - b.position || a.id - b.id);
}

async function createQuestion(q) {
  if (USE_DB) {
    const r = await pool.query(
      `INSERT INTO survey_questions (key, step_number, step_title, step_help, position, title, help_text, type, required, config, show_if)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        q.key, q.step_number,
        JSON.stringify(q.step_title || {}),
        q.step_help ? JSON.stringify(q.step_help) : null,
        q.position,
        JSON.stringify(q.title || {}),
        q.help_text ? JSON.stringify(q.help_text) : null,
        q.type, !!q.required,
        q.config ? JSON.stringify(q.config) : null,
        q.show_if ? JSON.stringify(q.show_if) : null,
      ]
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
         step_number=COALESCE($3, step_number),
         step_title=COALESCE($4, step_title),
         step_help=$5,
         position=COALESCE($6, position),
         title=COALESCE($7, title),
         help_text=$8,
         type=COALESCE($9, type),
         required=COALESCE($10, required),
         config=$11,
         show_if=$12
       WHERE id=$1 RETURNING *`,
      [
        id, q.key, q.step_number,
        q.step_title ? JSON.stringify(q.step_title) : null,
        q.step_help ? JSON.stringify(q.step_help) : null,
        q.position,
        q.title ? JSON.stringify(q.title) : null,
        q.help_text ? JSON.stringify(q.help_text) : null,
        q.type, q.required,
        q.config ? JSON.stringify(q.config) : null,
        q.show_if ? JSON.stringify(q.show_if) : null,
      ]
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

async function insertResponse(payload) {
  const { company_name, contact_name, position, phone, language, answers } = payload;
  if (USE_DB) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO survey_responses (company_name, contact_name, position, phone, language)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
        [company_name, contact_name || null, position || null, phone || null, language || 'ru']
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
    company_name, contact_name, position, phone,
    language: language || 'ru',
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
      (byResp[a.response_id] = byResp[a.response_id] || []).push({
        question_id: a.question_id,
        question_key: a.question_key,
        value: a.value,
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
// Branching evaluator
// show_if formats:
//   { question_key, values: [...] }                     — legacy (values-in)
//   { question_key, op: 'in',  values: [...] }
//   { question_key, op: 'eq',  value: X }
//   { question_key, op: 'lte', value: N } | 'gte' | 'lt' | 'gt'
// ========================================================================
function isVisible(question, answerMap) {
  const rule = question.show_if;
  if (!rule) return true;
  const v = answerMap.get(rule.question_key);
  if (v === undefined) return false;
  const op = rule.op || 'in';
  if (op === 'in') {
    const arr = rule.values || [];
    if (Array.isArray(v)) return v.some((x) => arr.includes(x));
    return arr.includes(v);
  }
  if (op === 'eq') return v === rule.value;
  const n = Number(v);
  if (!Number.isFinite(n)) return false;
  if (op === 'lte') return n <= Number(rule.value);
  if (op === 'gte') return n >= Number(rule.value);
  if (op === 'lt') return n < Number(rule.value);
  if (op === 'gt') return n > Number(rule.value);
  return false;
}

// ========================================================================
// STATS
// ========================================================================
function computeStats(responses) {
  const totalResponses = responses.length;
  const valByKey = (key) => responses
    .map((r) => r.answers.find((a) => a.question_key === key))
    .filter(Boolean)
    .map((a) => a.value);

  const npsValues = valByKey('nps').map(Number).filter((v) => Number.isFinite(v));
  const prom = npsValues.filter((v) => v >= 9).length;
  const det = npsValues.filter((v) => v <= 6).length;
  const neu = npsValues.length - prom - det;
  const npsScore = npsValues.length ? Math.round((prom - det) / npsValues.length * 100) : null;

  const avg = (arr) => arr.length ? +(arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(2) : null;

  // Build a full breakdown for a 1–5 scale question: avg, count, histogram
  // of tile counts, and detractor/neutral/promoter splits so the dashboard
  // can render NPS-style colour bars for CSAT / UX / support / manager.
  const scaleBreakdown = (key) => {
    const nums = valByKey(key).map(Number).filter(Number.isFinite);
    if (!nums.length) {
      return { avg: null, count: 0, histogram: { 1:0, 2:0, 3:0, 4:0, 5:0 },
               detractors: 0, neutrals: 0, promoters: 0 };
    }
    const histogram = { 1:0, 2:0, 3:0, 4:0, 5:0 };
    for (const n of nums) {
      const k = Math.max(1, Math.min(5, Math.round(n)));
      histogram[k] += 1;
    }
    return {
      avg: avg(nums),
      count: nums.length,
      histogram,
      detractors: histogram[1] + histogram[2],
      neutrals:   histogram[3],
      promoters:  histogram[4] + histogram[5],
    };
  };

  const csatProduct = scaleBreakdown('csat_product');
  const scales = {
    web_ux_score:    scaleBreakdown('web_ux_score'),
    mobile_ux_score: scaleBreakdown('mobile_ux_score'),
    support_score:   scaleBreakdown('support_score'),
    manager_score:   scaleBreakdown('manager_score'),
  };

  // Defensive: drop values that are Unicode replacement characters (lone
  // \uFFFD means the original bytes were not valid UTF-8 and should NOT
  // be shown to the operator as mojibake). Also drop empty strings.
  const looksCorrupt = (s) => {
    const str = String(s);
    // 1+ replacement char OR entirely non-readable punctuation
    return /\uFFFD/.test(str) || str.trim() === '';
  };
  const distribution = (key) => {
    // Quietly drop corrupt values — they used to be surfaced as a
    // "(данные повреждены)" row in the dashboard, but that polluted
    // every distribution chart with the same noise. Bad data still
    // lives in the DB row and can be deleted from the responses tab.
    const out = {};
    for (const v of valByKey(key)) {
      const raw = Array.isArray(v) ? '—' : String(v);
      if (looksCorrupt(raw)) continue;
      out[raw] = (out[raw] || 0) + 1;
    }
    return out;
  };

  // Language distribution
  const langDist = {};
  for (const r of responses) {
    const l = r.language || 'ru';
    langDist[l] = (langDist[l] || 0) + 1;
  }

  return {
    totalResponses,
    nps: { score: npsScore, promoters: prom, neutrals: neu, detractors: det, count: npsValues.length },
    csatProduct,
    scales,
    distributions: {
      roi_category: distribution('roi_category'),
      renewal_intent: distribution('renewal_intent'),
      industry: distribution('industry'),
      company_size: distribution('company_size'),
      mobile_usage: distribution('mobile_usage'),
      callback_request: distribution('callback_request'),
      headcount_plans: distribution('headcount_plans'),
      reference_willingness: distribution('reference_willingness'),
    },
    languageDistribution: langDist,
  };
}

// ========================================================================
// MIDDLEWARE
// ========================================================================
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function checkAuth(req) {
  const raw = req.query.password || req.headers['x-admin-password'] || (req.body && req.body.password);
  // Trim client-side whitespace too — some browsers trail a space on
  // auto-fill / password managers and we don't want that locking anyone out.
  const pwd = raw == null ? '' : String(raw).trim();
  if (!pwd) return false;
  return pwd === ADMIN_PASSWORD || pwd === ADMIN_PASSWORD_RECOVERY;
}
function requireAuth(req, res, next) {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Неверный пароль' });
  next();
}

// Password fingerprint — public, no auth, doesn't reveal the actual
// password but lets the operator confirm what's in env vs. what they
// think they typed. If the operator's expected password produces a
// different fingerprint than what's shown here, the values don't match.
app.get('/api/admin/pwd-fingerprint', (req, res) => {
  const fp = (s) => {
    const v = String(s || '').trim();
    if (!v) return { length: 0, first: '', last: '', empty: true };
    return {
      length: v.length,
      first: v[0],
      last: v[v.length - 1],
      sample: v[0] + '*'.repeat(Math.max(0, v.length - 2)) + v[v.length - 1],
    };
  };
  res.json({
    primary:  fp(ADMIN_PASSWORD),
    recovery: fp(ADMIN_PASSWORD_RECOVERY),
    note: 'Сравните длину/первый-последний символ с тем что вы вводите. Не совпадает — где-то опечатка.',
  });
});

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
    res.json({ questions: qs, languages: LANGS });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/survey/responses', async (req, res) => {
  try {
    const { company_name, contact_name, position, phone, language, answers } = req.body || {};
    if (!company_name || !String(company_name).trim()) {
      return res.status(400).json({ error: 'Укажите название компании' });
    }
    if (!contact_name || !String(contact_name).trim()) {
      return res.status(400).json({ error: 'Укажите ФИО' });
    }
    if (!phone || !isPhoneValid(String(phone))) {
      return res.status(400).json({ error: 'Укажите корректный номер телефона (+998 и минимум 9 цифр)' });
    }
    if (!Array.isArray(answers)) {
      return res.status(400).json({ error: 'Некорректный формат ответов' });
    }
    const lang = LANGS.includes(language) ? language : DEFAULT_LANG;

    const questions = await getAllQuestions();
    const answerMap = new Map();
    for (const a of answers) {
      if (a && a.question_key) answerMap.set(a.question_key, a.value);
    }
    // Merge identity fields so validation for questions with matching keys passes
    if (company_name) answerMap.set('company_name', String(company_name));
    if (contact_name) answerMap.set('contact_name', String(contact_name));
    if (position)     answerMap.set('position',     String(position));
    if (phone)        answerMap.set('phone',        String(phone));

    const IDENTITY_KEYS = new Set(['company_name', 'contact_name', 'position', 'phone']);
    for (const q of questions) {
      if (!q.required) continue;
      if (IDENTITY_KEYS.has(q.key)) continue; // already validated above
      if (!isVisible(q, answerMap)) continue;
      const v = answerMap.get(q.key);
      const empty = v === undefined || v === null || v === '' ||
                    (Array.isArray(v) && v.length === 0);
      if (empty) {
        return res.status(400).json({
          error: `Ответьте на обязательный вопрос: «${tr(q.title, lang)}»`,
        });
      }
    }

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
      contact_name: contact_name ? String(contact_name).trim().slice(0, 200) : null,
      position: position ? String(position).trim().slice(0, 200) : null,
      phone: phone ? String(phone).trim().slice(0, 50) : null,
      language: lang,
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
    if (!q.key || !q.title || !q.type || !q.step_number || !q.step_title) {
      return res.status(400).json({ error: 'Заполните ключ, заголовок, тип, номер и название шага' });
    }
    const row = await createQuestion({
      key: String(q.key).trim(),
      step_number: parseInt(q.step_number, 10),
      step_title: q.step_title,
      step_help: q.step_help || null,
      position: q.position ? parseInt(q.position, 10) : 99,
      title: q.title,
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
      step_number: q.step_number != null ? parseInt(q.step_number, 10) : undefined,
      step_title: q.step_title,
      step_help: q.step_help,
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

// Delete a single survey response (e.g. corrupt test data). Cascades to
// the answers via the FK ON DELETE CASCADE. Memory-store path mirrors.
app.delete('/api/admin/survey/responses/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Неверный id' });
  try {
    if (USE_DB) {
      const r = await pool.query('DELETE FROM survey_responses WHERE id = $1', [id]);
      return res.json({ ok: true, deleted: r.rowCount });
    } else {
      const before = memStore.responses.length;
      memStore.responses = memStore.responses.filter((r) => r.id !== id);
      memStore.answers = memStore.answers.filter((a) => a.response_id !== id);
      return res.json({ ok: true, deleted: before - memStore.responses.length });
    }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// CSV export — includes language column, question titles in RU
app.get('/api/admin/survey/export.csv', requireAuth, async (req, res) => {
  try {
    const [responses, questions] = await Promise.all([
      getAllResponses(),
      getAllQuestions({ includeDeleted: true }),
    ]);
    const cols = ['id', 'created_at', 'language', 'company_name', 'contact_name', 'position', 'phone',
                  ...questions.map((q) => q.key)];
    const escape = (s) => {
      if (s === null || s === undefined) return '';
      const str = Array.isArray(s) ? s.join(' | ') : String(s);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const lines = [cols.join(',')];
    for (const r of responses) {
      const byKey = new Map(r.answers.map((a) => [a.question_key, a.value]));
      const row = [
        r.id, r.created_at, r.language || 'ru',
        r.company_name, r.contact_name || '', r.position || '', r.phone || '',
        ...questions.map((q) => escape(byKey.get(q.key))),
      ];
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

// Excel export — we ship an HTML table with a .xls extension.
// Excel / LibreOffice Calc / Google Sheets all open this cleanly and
// preserve Unicode, unlike CSV which needs a BOM for Cyrillic. This
// avoids pulling in a heavy xlsx dependency.
app.get('/api/admin/survey/export.xls', requireAuth, async (req, res) => {
  try {
    const [responses, questions] = await Promise.all([
      getAllResponses(),
      getAllQuestions({ includeDeleted: true }),
    ]);
    const esc = (s) => {
      if (s === null || s === undefined) return '';
      const str = Array.isArray(s) ? s.join(' | ') : String(s);
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };
    const header = ['ID', 'Дата', 'Язык', 'Компания', 'ФИО', 'Должность', 'Телефон',
                    ...questions.map((q) => (q.title && q.title.ru) || q.key)];
    const rows = responses.map((r) => {
      const byKey = new Map(r.answers.map((a) => [a.question_key, a.value]));
      return [r.id, r.created_at, r.language || 'ru',
              r.company_name, r.contact_name || '', r.position || '', r.phone || '',
              ...questions.map((q) => byKey.get(q.key))];
    });
    const html =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">' +
      '<head><meta http-equiv="content-type" content="application/vnd.ms-excel; charset=UTF-8"/></head>' +
      '<body><table border="1" cellspacing="0">' +
      '<tr>' + header.map((h) => `<th>${esc(h)}</th>`).join('') + '</tr>' +
      rows.map((row) => '<tr>' + row.map((v) => `<td>${esc(v)}</td>`).join('') + '</tr>').join('') +
      '</table></body></html>';
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="verifix_survey.xls"');
    res.send('\uFEFF' + html);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ========================================================================
// PAGES
// ========================================================================
// HTML pages: disable browser caching so layout/UX updates reach users
// immediately on next visit — avoids stale cache after a redeploy.
function sendHtmlNoCache(res, filename) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', filename));
}
app.get('/survey',       (req, res) => sendHtmlNoCache(res, 'survey.html'));
app.get('/v10',          (req, res) => sendHtmlNoCache(res, 'survey-v10.html'));
app.get('/admin',        (req, res) => sendHtmlNoCache(res, 'admin.html'));
app.get('/admin/survey', (req, res) => sendHtmlNoCache(res, 'admin-survey.html'));

app.get('/healthz', (req, res) => res.send('ok'));

initDb()
  .then(() => app.listen(PORT, () => console.log(`Verifix app listening on :${PORT}`)))
  .catch((err) => { console.error('DB init failed:', err); process.exit(1); });
