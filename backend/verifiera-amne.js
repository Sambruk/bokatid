'use strict';
// Skarptest av bokning om tjänst eller projekt mot två tillfälliga testvärdar.
// Lägger upp värdarna och ett testämne direkt i databasen, bokar genom det
// publika API:t och kontrollerar rundgången: första bokningen till den som står
// först, nästa till den andra, en tid som bara den ena har ledig till den, och
// 409 när ingen är ledig.
//
// Skickar VERKLIG e-post: bokningsbesked till --bokare och "ny bokning" till
// testvärdarna, som får plusadresser av --bokare. Testvärdarna saknar
// kalenderkoppling, så ingen kalender skrivs. Städar alltid efter sig genom att
// radera i databasen — inga avbokningsmejl.
//
//   docker compose exec -T boka-tid-app node verifiera-amne.js --bokare namn@exempel.se

const { q, pool } = require('./lib/db');
const { randomToken } = require('./lib/crypto');
const { SYSTEM_TYP } = require('./lib/crm-synk');

const BAS = 'http://127.0.0.1:3000';
const i = process.argv.indexOf('--bokare');
const BOKARE = i > -1 ? process.argv[i + 1] : '';
if (!/^[^@\s+]+@[^@\s]+\.[^@\s]+$/.test(BOKARE)) {
  console.error('\nAnge en adress utan plustecken: node verifiera-amne.js --bokare namn@exempel.se\n');
  process.exit(1);
}
const [lokal, doman] = BOKARE.split('@');

let ok = 0;
let fel = 0;
const kolla = (namn, villkor, info = '') => {
  if (villkor) {
    ok++;
    console.log('  OK  ', namn);
  } else {
    fel++;
    console.log(' FEL  ', namn, info ? `— ${String(info).slice(0, 400)}` : '');
  }
  return villkor;
};

async function api(metod, vag, body) {
  const res = await fetch(`${BAS}${vag}`, {
    method: metod,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const id = randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, '');
const vardar = [];
const amneId = `verifiering-${id}`;
const amneSlug = `verifiering-${id}`;

async function upplagg() {
  for (const bokstav of ['a', 'b']) {
    const { rows } = await q(
      `INSERT INTO users (slug, name, email, role, password_hash, created_via)
       VALUES ($1, $2, $3, 'host', NULL, 'admin') RETURNING id, slug, name, email`,
      [`test-amne-${id}-${bokstav}`, `Testvärd ${bokstav.toUpperCase()}`, `${lokal}+bt-amne-${id}-${bokstav}@${doman}`]
    );
    const v = rows[0];
    vardar.push(v);
    for (const weekday of [1, 2, 3, 4, 5]) {
      await q('INSERT INTO availability_rules (user_id, weekday, start_min, end_min) VALUES ($1,$2,$3,$4)', [v.id, weekday, 8 * 60, 17 * 60]);
    }
    await q(
      `INSERT INTO event_types (user_id, slug, title, duration_min, location_type, system_typ)
       VALUES ($1, 'om-amne', 'Samtal om tjänst eller projekt', 30, 'teams', $2)`,
      [v.id, SYSTEM_TYP]
    );
  }
  await q(
    `INSERT INTO amnen (crm_id, slug, namn, typ, korttext, ansvariga_epost)
     VALUES ($1, $2, $3, 'Tjänst', 'Testämne för verifiering', $4)`,
    [amneId, amneSlug, `Verifiering ${id}`, vardar.map((v) => v.email.toLowerCase())]
  );
}

async function stada() {
  const ids = vardar.map((v) => v.id);
  if (!ids.length) return;
  await q('DELETE FROM bookings WHERE user_id = ANY ($1::int[]) OR amne_id = $2', [ids, amneId]);
  await q('DELETE FROM amnen WHERE crm_id = $1', [amneId]);
  await q('DELETE FROM users WHERE id = ANY ($1::int[])', [ids]);
}

async function main() {
  await upplagg();
  const [A, B] = vardar;
  console.log(`Testämne ${amneSlug}, värdar ${A.slug} och ${B.slug}\n`);

  const lista = await api('GET', '/api/amnen');
  const amne = (lista.json.amnen || []).find((a) => a.slug === amneSlug);
  kolla('ämnet listas med båda värdarna', amne && amne.vardar.length === 2, JSON.stringify(amne));
  kolla('listan lämnar inte ut e-postadresser', !JSON.stringify(lista.json).includes(`+bt-amne-${id}`));

  const info = await api('GET', `/api/amnen/${amneSlug}`);
  kolla('ämnessidans data har rubriken "Samtal om …"', info.json.eventType?.title === `Samtal om Verifiering ${id}`, JSON.stringify(info.json));

  const tider = await api('GET', `/api/amnen/${amneSlug}/slots`);
  const alla = (tider.json.days || []).flatMap((d) => d.slots);
  kolla('det finns lediga tider', alla.length >= 2, JSON.stringify(tider.json).slice(0, 200));
  const [t1, t2] = alla;

  const bokare = (n) => ({ name: `Verifiering ${n}`, email: BOKARE, org: 'Test' });
  const b1 = await api('POST', `/api/amnen/${amneSlug}/book`, { ...bokare(1), start: t1.start });
  kolla('första bokningen går till den som står först', b1.status === 201 && b1.json.booking?.vard?.name === A.name, JSON.stringify(b1.json));

  const b2 = await api('POST', `/api/amnen/${amneSlug}/book`, { ...bokare(2), start: t2.start });
  kolla('nästa bokning, när båda är lediga, går till den andra (rundgång)', b2.status === 201 && b2.json.booking?.vard?.name === B.name, JSON.stringify(b2.json));

  const b3 = await api('POST', `/api/amnen/${amneSlug}/book`, { ...bokare(3), start: t1.start });
  kolla('samma tid igen går till den som fortfarande är ledig', b3.status === 201 && b3.json.booking?.vard?.name === B.name, JSON.stringify(b3.json));

  const b4 = await api('POST', `/api/amnen/${amneSlug}/book`, { ...bokare(4), start: t1.start });
  kolla('när ingen är ledig blir det 409', b4.status === 409, `${b4.status} ${JSON.stringify(b4.json)}`);

  const { rows } = await q('SELECT user_id, amne_id, rubrik, cancel_token FROM bookings WHERE amne_id = $1 ORDER BY id', [amneId]);
  kolla('bokningarna bär ämnet och rubriken', rows.length === 3 && rows.every((r) => r.rubrik === `Samtal om Verifiering ${id}`), JSON.stringify(rows));

  const avb = await api('GET', `/api/booking/${rows[0]?.cancel_token}`);
  kolla('avbokningssidan visar ämnets rubrik', avb.json.title === `Samtal om Verifiering ${id}`, JSON.stringify(avb.json));

  const dold = await api('GET', `/api/event-type/${A.slug}/om-amne`);
  kolla('system-mötestypen nås inte via värdens adress', dold.status === 404, dold.status);

  const tider2 = await api('GET', `/api/amnen/${amneSlug}/slots`);
  const kvar = (tider2.json.days || []).flatMap((d) => d.slots).some((s) => s.start === t1.start);
  kolla('den fullbokade tiden visas inte längre', !kvar);
}

main()
  .catch((err) => {
    fel++;
    console.error('Avbrutet:', err);
  })
  .finally(async () => {
    try {
      await stada();
      console.log('\nStädat: testvärdar, testämne och bokningar raderade.');
    } catch (err) {
      console.error('Städningen misslyckades:', err.message);
    }
    console.log(`\n${ok} OK, ${fel} FEL`);
    await pool.end();
    process.exit(fel ? 1 : 0);
  });
