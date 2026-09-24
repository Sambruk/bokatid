'use strict';
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { hashPassword } = require('./crypto');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

const q = (sql, params) => pool.query(sql, params);

async function waitForDatabase(tries = 30) {
  for (let i = 1; i <= tries; i++) {
    try {
      await q('SELECT 1');
      return;
    } catch (err) {
      if (i === tries) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/**
 * Schemat körs vid varje start. Allt är IF NOT EXISTS, så det är ofarligt, och
 * det gör att en befintlig databasvolym inte missar schemat bara för att
 * postgres initdb-hooken redan hade körts en gång.
 */
async function applySchema() {
  const file = path.join(__dirname, '..', 'schema.sql');
  if (!fs.existsSync(file)) return;
  await q(fs.readFileSync(file, 'utf8'));
}

/** Första start: lägg upp värden, ett rimligt veckoschema och en mötestyp. */
async function seed() {
  const email = process.env.ADMIN_EMAIL;
  if (!email) return;
  const existing = await q('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rowCount) return;

  const hash = process.env.ADMIN_PASSWORD ? hashPassword(process.env.ADMIN_PASSWORD) : null;
  const { rows } = await q(
    `INSERT INTO users (slug, name, email, role, password_hash)
     VALUES ($1, $2, $3, 'admin', $4) RETURNING id`,
    [process.env.ADMIN_SLUG || 'admin', process.env.ADMIN_NAME || email, email, hash]
  );
  const userId = rows[0].id;

  for (const weekday of [1, 2, 3, 4, 5]) {
    await q(
      'INSERT INTO availability_rules (user_id, weekday, start_min, end_min) VALUES ($1, $2, $3, $4)',
      [userId, weekday, 9 * 60, 16 * 60]
    );
  }

  await q(
    `INSERT INTO event_types (user_id, slug, title, description, duration_min,
       buffer_after, slot_step_min, min_notice_min, max_days_ahead, location_type, questions)
     VALUES ($1, 'samtal', 'Samtal med Sambruk',
       'Ett kort digitalt möte. Berätta gärna i förväg vad du vill prata om.',
       30, 15, 30, 240, 60, 'teams', $2)`,
    [userId, JSON.stringify([{ key: 'Vad vill du prata om?', type: 'textarea', required: false }])]
  );

  await audit('system', 'seed', { userId, email });
}

function audit(actor, action, detail = {}) {
  return q('INSERT INTO audit_log (actor, action, detail) VALUES ($1, $2, $3)', [
    actor,
    action,
    JSON.stringify(detail),
  ]).catch(() => {});
}

module.exports = { pool, q, waitForDatabase, applySchema, seed, audit };
