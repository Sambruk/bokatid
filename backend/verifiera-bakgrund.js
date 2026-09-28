'use strict';
// Skarptest av att en omröstning svarar direkt och att reservationerna i
// kalendern skapas i bakgrunden — och att inget blir liggande i kalendern om
// omröstningen tas bort medan jobbet pågår.
//
// Gör VERKLIGA anrop mot värdens Microsoft 365-kalender men skickar ingen
// e-post (inga deltagare). Städar efter sig.
//
//   docker compose exec -T boka-tid-app node verifiera-bakgrund.js

const BAS = 'http://127.0.0.1:3000';
const { q } = require('./lib/db');
const { decrypt } = require('./lib/crypto');
const graph = require('./lib/graph');

let fel = 0;
const rad = (ok, text, extra) => {
  console.log(`${ok ? '  OK  ' : ' FEL  '} ${text}${extra ? ' — ' + extra : ''}`);
  if (!ok) fel++;
  return ok;
};

let kaka = '';
async function anrop(vag, { metod = 'GET', kropp } = {}) {
  const res = await fetch(`${BAS}${vag}`, {
    method: metod,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'boka-tid', ...(kaka ? { cookie: kaka } : {}) },
    body: kropp ? JSON.stringify(kropp) : undefined,
  });
  const satt = res.headers.get('set-cookie');
  if (satt) kaka = satt.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function token(userId) {
  const { rows } = await q('SELECT refresh_token FROM ms_accounts WHERE user_id = $1', [userId]);
  return rows.length ? (await graph.refresh(decrypt(rows[0].refresh_token))).access_token : null;
}

/** Reservationer med given rubrik i kalendern inom intervallet. */
async function iKalendern(tok, titel, fran, till) {
  const vag = `/me/calendarView?startDateTime=${fran}&endDateTime=${till}&$select=id,subject&$top=100`;
  const svar = await graph.call(tok, vag);
  return (svar.value || []).filter((h) => h.subject === `Preliminär: ${titel}`);
}

async function skapa(titel, tider) {
  const t0 = Date.now();
  const r = await anrop('/api/admin/polls', {
    metod: 'POST',
    kropp: { title: titel, duration_min: 30, location_type: 'teams', options: tider, participants: [], hold_calendar: true },
  });
  return { ...r, ms: Date.now() - t0 };
}

(async () => {
  console.log('\nSkarptest: omröstningens reservationer i bakgrunden\n');
  const inlogg = await anrop('/api/login', {
    metod: 'POST',
    kropp: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
  });
  if (!rad(inlogg.data.ok === true, 'Inloggad som värd', inlogg.data.error)) process.exit(1);
  const { rows: [jag] } = await q('SELECT id FROM users WHERE lower(email) = lower($1)', [process.env.ADMIN_EMAIL]);
  const tok = await token(jag.id);
  if (!rad(Boolean(tok), 'Kalendern är kopplad')) process.exit(1);

  const fran = new Date(Date.now() + 45 * 86400_000).toISOString().slice(0, 10);
  const till = new Date(Date.now() + 60 * 86400_000).toISOString().slice(0, 10);
  const { data: lediga } = await anrop(`/api/admin/poll-slots?duration=30&from=${fran}&to=${till}`);
  const alla = (lediga.days || []).flatMap((d) => d.slots.slice(0, 1)).map((s) => s.start);
  if (!rad(alla.length >= 10, 'Minst tio lediga tider att föreslå', `hittade ${alla.length}`)) process.exit(1);
  const fonsterFran = `${fran}T00:00:00Z`, fonsterTill = `${till}T23:59:59Z`;

  // 1. Vanligt flöde: fem tider
  const titel1 = `Bakgrundstest A ${Date.now()}`;
  const a = await skapa(titel1, alla.slice(0, 5));
  rad(a.status === 201, 'Omröstning A skapades', a.data.error);
  rad(a.ms < 2500, `Svar direkt (${a.ms} ms)`);
  const t0 = Date.now();
  let d;
  for (let i = 0; i < 80; i++) {
    d = (await anrop(`/api/admin/polls/${a.data.poll.id}`)).data;
    if (!d.poll.bakgrund) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const klara = d.options.filter((o) => o.holdOk).length;
  rad(klara === 5, `Fem reservationer klara i bakgrunden efter ${Date.now() - t0} ms`, `klara ${klara}`);
  rad((await iKalendern(tok, titel1, fonsterFran, fonsterTill)).length === 5, 'Fem reservationer finns i Outlook');
  const bortA = await anrop(`/api/admin/polls/${a.data.poll.id}`, { metod: 'DELETE' });
  rad(bortA.data.releasedHolds === 5, 'Borttagning släppte fem reservationer', JSON.stringify(bortA.data));
  rad((await iKalendern(tok, titel1, fonsterFran, fonsterTill)).length === 0, 'Inget kvar i Outlook för A');

  // 2. Kapplöpning: ta bort direkt, medan reservationerna fortfarande skapas
  const titel2 = `Bakgrundstest B ${Date.now()}`;
  const b = await skapa(titel2, alla.slice(5, 10));
  rad(b.status === 201, 'Omröstning B skapades', b.data.error);
  const bortB = await anrop(`/api/admin/polls/${b.data.poll.id}`, { metod: 'DELETE' });
  rad(bortB.status === 200, 'B togs bort direkt efter skapandet', JSON.stringify(bortB.data));
  await new Promise((r) => setTimeout(r, 3000));
  const kvar = await iKalendern(tok, titel2, fonsterFran, fonsterTill);
  rad(kvar.length === 0, 'Inget kvar i Outlook för B', `${kvar.length} kvar`);
  for (const h of kvar) await graph.deleteEvent(tok, h.id).catch(() => {});

  console.log(fel ? `\n${fel} kontroller misslyckades.\n` : '\nAlla kontroller gröna.\n');
  process.exit(fel ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
