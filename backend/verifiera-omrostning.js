'use strict';
// Skarptest av omröstningsfunktionen mot en riktig Microsoft 365-kalender:
// skapa omröstning → preliminärbokningar i kalendern → tiderna blockeras för
// vanlig bokning → rösta → besluta tid → riktigt möte + reservationerna borta.
//
// Gör VERKLIGA anrop och skickar VERKLIG e-post till adressen du anger.
// Städar efter sig: raderar mötet ur kalendern och omröstningen ur databasen.
//
//   docker compose exec -T boka-tid-app node verifiera-omrostning.js --deltagare namn@exempel.se

const BAS = 'http://127.0.0.1:3000';

const arg = (namn, standard) => {
  const i = process.argv.indexOf(`--${namn}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : standard;
};
const DELTAGARE = arg('deltagare', null);

if (!DELTAGARE || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(DELTAGARE)) {
  console.error('\nAnge vem testinbjudan ska skickas till:');
  console.error('  node verifiera-omrostning.js --deltagare namn@exempel.se\n');
  process.exit(1);
}

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
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'boka-tid',
      ...(kaka ? { cookie: kaka } : {}),
    },
    body: kropp ? JSON.stringify(kropp) : undefined,
  });
  const satt = res.headers.get('set-cookie');
  if (satt) kaka = satt.split(';')[0];
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/** Token för omröstningens ägare — inte för "någon" som råkar ha en koppling. */
async function token(userId) {
  const { rows } = await q(
    userId
      ? 'SELECT refresh_token FROM ms_accounts WHERE user_id = $1'
      : 'SELECT refresh_token FROM ms_accounts ORDER BY user_id LIMIT 1',
    userId ? [userId] : []
  );
  if (!rows.length) return null;
  const d = await graph.refresh(decrypt(rows[0].refresh_token));
  return d.access_token;
}

(async () => {
  console.log('\nSkarptest av omröstningar\n');

  const inlogg = await anrop('/api/login', {
    metod: 'POST',
    kropp: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
  });
  if (!rad(inlogg.data.ok === true, 'Inloggad som värd', inlogg.data.error)) process.exit(1);

  // Tre lediga tider, spridda över olika dagar för att likna ett verkligt fall.
  const fran = new Date(Date.now() + 28 * 86400_000).toISOString().slice(0, 10);
  const till = new Date(Date.now() + 40 * 86400_000).toISOString().slice(0, 10);
  const { data: lediga } = await anrop(`/api/admin/poll-slots?duration=60&from=${fran}&to=${till}`);
  rad(lediga.calendarChecked === true, 'Lediga tider hämtade med kalendern inräknad');

  const valda = (lediga.days || []).slice(0, 3).map((d) => d.slots[0]).filter(Boolean);
  if (!rad(valda.length === 3, 'Tre lediga tider att föreslå', `hittade ${valda.length}`)) process.exit(1);

  const skapa = await anrop('/api/admin/polls', {
    metod: 'POST',
    kropp: {
      title: 'Skarptest omröstning (kan ignoreras)',
      description: 'Automatisk kontroll av omröstningsfunktionen.',
      duration_min: 60,
      location_type: 'teams',
      options: valda.map((s) => s.start),
      participants: [{ name: 'Testdeltagare', email: DELTAGARE, org: 'Sambruk' }],
      hold_calendar: true,
    },
  });
  if (!rad(skapa.status === 201, 'Omröstningen skapades', skapa.data.error)) process.exit(1);
  const pollId = skapa.data.poll.id;
  rad(skapa.data.holds.skapade === 3, 'Tre preliminärbokningar skapades i kalendern',
    `skapade ${skapa.data.holds.skapade}, fel: ${(skapa.data.holds.fel || []).join('; ') || 'inga'}`);
  rad(skapa.data.invitations.skickade === 1, 'Inbjudan skickades till deltagaren');

  // Ligger reservationerna verkligen i kalendern, och som preliminära?
  const { rows: [agare] } = await q('SELECT user_id FROM polls WHERE id = $1', [pollId]);
  const t1 = await token(agare.user_id);
  const { rows: optioner } = await q('SELECT * FROM poll_options WHERE poll_id = $1 ORDER BY start_utc', [pollId]);
  let preliminara = 0;
  for (const o of optioner) {
    if (!o.graph_event_id) continue;
    try {
      const h = await graph.call(t1, `/me/events/${encodeURIComponent(o.graph_event_id)}?$select=id,subject,showAs`);
      if (h.showAs === 'tentative') preliminara++;
    } catch (err) {
      /* räknas som saknad nedan */
    }
  }
  rad(preliminara === 3, 'Alla tre ligger i kalendern markerade som preliminära', `hittade ${preliminara}`);

  // Blockerar reservationerna den vanliga bokningssidan?
  const forsta = optioner[0];
  const dag = new Date(forsta.start_utc).toISOString().slice(0, 10);
  const { data: vanliga } = await anrop(`/api/slots/${arg('vard', 'thomas')}/samtal?from=${dag}&to=${dag}`);
  const krockar = (vanliga.days || []).some((d) =>
    d.slots.some((s) => new Date(s.start) < new Date(forsta.end_utc) && new Date(s.end) > new Date(forsta.start_utc))
  );
  rad(!krockar, 'Den reserverade tiden erbjuds inte på den vanliga bokningssidan');

  // Går det att föreslå samma tid i en ny omröstning? Det ska nekas.
  const dubbel = await anrop('/api/admin/polls', {
    metod: 'POST',
    kropp: {
      title: 'Ska nekas',
      duration_min: 60,
      options: [new Date(forsta.start_utc).toISOString()],
      participants: [],
    },
  });
  rad(dubbel.status === 409, 'En redan reserverad tid kan inte föreslås igen', `status ${dubbel.status}`);

  // Rösta som deltagaren, via den personliga länken.
  const { data: detalj } = await anrop(`/api/admin/polls/${pollId}`);
  const deltagarUrl = detalj.participants[0].url;
  const svarToken = new URL(deltagarUrl).searchParams.get('svar');
  const publicToken = new URL(detalj.poll.url).pathname.split('/').pop();

  const rost = await anrop(`/api/poll/${publicToken}/vote`, {
    metod: 'POST',
    kropp: {
      svarToken,
      name: 'Testdeltagare',
      svar: { [optioner[0].id]: 'nej', [optioner[1].id]: 'ja', [optioner[2].id]: 'kanske' },
    },
  });
  rad(rost.data.ok === true && rost.data.sparade === 3, 'Rösterna sparades', rost.data.error);

  const { data: efterRost } = await anrop(`/api/admin/polls/${pollId}`);
  const basta = efterRost.options[0];
  rad(basta.id === optioner[1].id, 'Tiden med flest ja rankas högst');
  rad(efterRost.participants[0].responded === true, 'Deltagaren är markerad som svarad');

  // Publika vyn ska visa räkningen men aldrig e-postadresser.
  const { data: publik } = await anrop(`/api/poll/${publicToken}`);
  rad(JSON.stringify(publik).includes(DELTAGARE) === false, 'Deltagarens e-postadress läcker inte i publika svaret');
  rad(publik.svarande?.length === 1, 'Publika vyn visar att en person svarat');

  // Besluta tiden med flest ja.
  const beslut = await anrop(`/api/admin/polls/${pollId}/decide`, {
    metod: 'POST',
    kropp: { optionId: optioner[1].id },
  });
  rad(beslut.data.ok === true, 'Beslutet gick igenom', beslut.data.error);
  rad(beslut.data.calendarWritten === true, 'Det riktiga mötet skrevs i kalendern');
  rad(Boolean(beslut.data.joinUrl), 'Teams-länk skapades för det beslutade mötet');
  rad(
    beslut.data.beskedViaOutlook === true,
    'Beskedet gick via Outlooks egen inbjudan — tjänsten skickade inget dubblettmail',
    `mailAccepted=${beslut.data.mailAccepted}, utanInbjudan=${beslut.data.antalUtanInbjudan}`
  );

  // Är alla reservationer borta ur kalendern nu?
  const t2 = await token(agare.user_id);
  let kvar = 0;
  for (const o of optioner) {
    if (!o.graph_event_id) continue;
    try {
      await graph.call(t2, `/me/events/${encodeURIComponent(o.graph_event_id)}?$select=id`);
      kvar++;
    } catch (err) {
      if (err.status !== 404) kvar++;
    }
  }
  rad(kvar === 0, 'Alla preliminärbokningar är borta ur kalendern', `kvar: ${kvar}`);

  const { rows: efter } = await q('SELECT status, decided_option, decided_event FROM polls WHERE id = $1', [pollId]);
  rad(efter[0].status === 'decided', 'Omröstningen är markerad som beslutad');
  const { rows: utanHold } = await q(
    'SELECT count(*)::int AS n FROM poll_options WHERE poll_id = $1 AND graph_event_id IS NOT NULL',
    [pollId]
  );
  rad(utanHold[0].n === 0, 'Inga reservationer kvar i databasen');

  // Städa: ta bort det riktiga mötet ur kalendern och omröstningen ur databasen.
  if (efter[0].decided_event && t2) {
    try {
      await graph.call(t2, `/me/events/${encodeURIComponent(efter[0].decided_event)}/cancel`, {
        method: 'POST',
        body: { Comment: 'Skarptest, mötet ställs in automatiskt.' },
      });
      rad(true, 'Testmötet avbokades i kalendern');
    } catch (err) {
      rad(false, 'Testmötet kunde inte avbokas — ta bort det manuellt', err.message);
    }
  }
  await q('DELETE FROM polls WHERE id = $1', [pollId]);
  rad(true, 'Testomröstningen raderad ur databasen');

  console.log(fel ? `\n${fel} fel.\n` : '\nHela omröstningskedjan fungerar.\n');
  process.exit(fel ? 1 : 0);
})().catch((err) => {
  console.error('Testet kraschade:', err);
  process.exit(1);
});
