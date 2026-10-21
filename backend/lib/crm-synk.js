'use strict';
// Ämnen ur CRM:et: tjänster och projekt med sina ansvariga, hämtade från
// vitlistan. Gör att man kan boka tid om ett ämne ("Stimma") i stället för med
// en namngiven person.
//
// Vitlistans endpoint är intern och kräver en token; svaret innehåller
// e-postadresser. De sparas här bara för att matchas mot users.email och
// lämnar aldrig servern.
//
// Körs i appens egen process vid start och sedan med jämna mellanrum, som
// gallringen. Ett fel eller en tom lista tömmer aldrig tabellen — då ligger
// den senaste lyckade synken kvar.

const { q, audit } = require('./db');

const URL_BAS = (process.env.VITLISTAN_URL || '').replace(/\/$/, '');
const TOKEN = process.env.VITLISTAN_TOKEN || '';
const MINUTER = 10;

const SYSTEM_TYP = 'amne';
const SYSTEM_SLUG = 'om-amne';

// Senaste körningen, för adminvyn.
const status = { senast: null, ok: null, fel: null, antal: null };

const aktiverad = () => Boolean(URL_BAS && TOKEN);

function slugFran(namn) {
  return (
    String(namn || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'amne'
  );
}

async function hamta() {
  const svar = await fetch(`${URL_BAS}/api/samverkan/ansvariga`, {
    headers: { 'x-vitlistan-token': TOKEN },
    signal: AbortSignal.timeout(20_000),
  });
  if (!svar.ok) throw new Error(`Vitlistan svarade ${svar.status}`);
  const data = await svar.json();
  if (!Array.isArray(data.samverkan)) throw new Error('Vitlistan gav inget samverkan-fält');
  return data.samverkan;
}

/**
 * Slug per ämne. En post som redan har en slug behåller den, så att länkar
 * fortsätter fungera även om namnet ändras i CRM:et. Krockar får ett suffix.
 */
async function slugFor(crmId, namn, upptagna) {
  const { rows } = await q('SELECT slug FROM amnen WHERE crm_id = $1', [crmId]);
  if (rows[0]) return rows[0].slug;
  const bas = slugFran(namn);
  for (let n = 1; ; n++) {
    const kandidat = n === 1 ? bas : `${bas}-${n}`;
    if (!upptagna.has(kandidat)) return kandidat;
  }
}

/**
 * Varje ansvarig som har konto får en egen mötestyp för ämnesbokningar, med
 * rimliga standardvärden. Värden kan sedan ändra längd, frågor m.m. i adminvyn.
 * Externa användare får ingen: de är inte ansvariga för Sambruks tjänster.
 */
async function skapaSystemtyper() {
  const { rowCount } = await q(
    `INSERT INTO event_types (user_id, slug, title, description, duration_min, location_type, system_typ)
     SELECT u.id, $1, 'Samtal om tjänst eller projekt',
            'Bokas från sidan för en tjänst eller ett projekt där du är ansvarig.', 30, 'teams', $2
     FROM users u
     WHERE u.active AND u.role <> 'extern'
       AND EXISTS (SELECT 1 FROM amnen a WHERE a.aktiv AND lower(u.email) = ANY (a.ansvariga_epost))
       AND NOT EXISTS (SELECT 1 FROM event_types e WHERE e.user_id = u.id AND e.system_typ = $2)
     ON CONFLICT DO NOTHING`,
    [SYSTEM_SLUG, SYSTEM_TYP]
  );
  return rowCount;
}

async function synka() {
  status.senast = new Date().toISOString();
  if (!aktiverad()) {
    status.ok = false;
    status.fel = 'Ej konfigurerad (BOKA_VITLISTAN_URL och BOKA_VITLISTAN_TOKEN)';
    return status;
  }
  try {
    const lista = await hamta();
    if (!lista.length) throw new Error('Vitlistan gav en tom lista');

    const { rows } = await q('SELECT slug FROM amnen');
    const upptagna = new Set(rows.map((r) => r.slug));
    const sedda = [];

    for (const s of lista) {
      if (!s.id || !s.name) continue;
      const slug = await slugFor(s.id, s.name, upptagna);
      upptagna.add(slug);
      sedda.push(s.id);
      const epost = [...new Set((s.ansvariga || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
      await q(
        `INSERT INTO amnen (crm_id, slug, namn, typ, korttext, ansvariga_epost, aktiv, synkad_at)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,now())
         ON CONFLICT (crm_id) DO UPDATE SET namn = EXCLUDED.namn, typ = EXCLUDED.typ,
           korttext = EXCLUDED.korttext, ansvariga_epost = EXCLUDED.ansvariga_epost,
           aktiv = TRUE, synkad_at = now()`,
        [s.id, slug, String(s.name).slice(0, 200), String(s.type || '').slice(0, 40), String(s.shortText || '').slice(0, 4000), epost]
      );
    }

    // Försvunna ur urvalet (avslutade, avpublicerade) döljs men raderas inte:
    // gamla bokningar pekar på dem.
    await q('UPDATE amnen SET aktiv = FALSE WHERE aktiv AND NOT (crm_id = ANY ($1))', [sedda]);
    const nyaTyper = await skapaSystemtyper();
    if (nyaTyper) await audit('system', 'amne_systemtyper_skapade', { antal: nyaTyper });

    status.ok = true;
    status.fel = null;
    status.antal = sedda.length;
  } catch (err) {
    status.ok = false;
    status.fel = String(err.message).slice(0, 300);
    await audit('system', 'crm_synk_misslyckades', { fel: status.fel });
  }
  return status;
}

function startaCrmSynk() {
  if (!aktiverad()) {
    console.log('CRM-synk avstängd: BOKA_VITLISTAN_URL/BOKA_VITLISTAN_TOKEN saknas');
    return;
  }
  synka().then((s) => console.log(s.ok ? `CRM-synk: ${s.antal} ämnen` : `CRM-synk misslyckades: ${s.fel}`));
  setInterval(() => synka().catch(() => {}), MINUTER * 60_000).unref();
}

module.exports = { synka, startaCrmSynk, status, aktiverad, SYSTEM_TYP, slugFran };
