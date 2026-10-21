'use strict';
// Skarptest av omröstningarna i agent-API:t (MCP) mot en tillfällig testvärd.
// Går igenom provfallet i docs/Bokatid_utbyggnad_omrostningar_i_agent-API.md:
// TESTMÖTE, 60 minuter, en tid per dag tre dagar, två inbjudna — skapas,
// besvaras, påminns, beslutas och avbryts helt via MCP.
//
// Skickar VERKLIG e-post till adresserna du anger (inbjudningar, en påminnelse,
// beslut). Testvärden saknar kalenderkoppling, så inga preliminärbokningar görs
// i del 1. Med --kalender <e-post> körs också del 2 mot den användarens riktiga
// Microsoft 365-kalender 70–90 dagar fram, utan deltagare och utan mejl.
// Städar alltid efter sig: testvärd, nycklar, omröstningar och reservationer.
//
//   docker compose exec -T boka-tid-app node verifiera-mcp-omrostning.js \
//     --deltagare namn+a@exempel.se,namn+b@exempel.se [--kalender vard@exempel.se]

const { q, pool } = require('./lib/db');
const { decrypt } = require('./lib/crypto');
const graph = require('./lib/graph');
const nycklar = require('./lib/agent-nycklar');

const BAS = 'http://127.0.0.1:3000';
const arg = (namn) => {
  const i = process.argv.indexOf(`--${namn}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const DELTAGARE = (arg('deltagare') || '').split(',').map((s) => s.trim()).filter(Boolean);
const KALENDER = arg('kalender');
if (DELTAGARE.length < 3 || DELTAGARE.some((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) {
  console.error('\nAnge tre testadresser (två i omröstningen, en läggs till i efterhand):');
  console.error('  node verifiera-mcp-omrostning.js --deltagare a@exempel.se,b@exempel.se,c@exempel.se [--kalender vard@exempel.se]\n');
  process.exit(1);
}

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
const vanta = (ms) => new Promise((r) => setTimeout(r, ms));

async function mcp(nyckel, method, params = {}) {
  const res = await fetch(`${BAS}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${nyckel}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function verktyg(nyckel, name, args = {}) {
  const r = await mcp(nyckel, 'tools/call', { name, arguments: args });
  const res = r.json.result || {};
  return { fel: res.isError ? res.content?.[0]?.text : null, data: res.structuredContent };
}
const verktygslista = async (nyckel) =>
  ((await mcp(nyckel, 'tools/list')).json.result?.tools || []).map((t) => t.name).sort();
const rest = (nyckel, vag, method = 'GET', body) =>
  fetch(`${BAS}${vag}`, {
    method,
    headers: { authorization: `Bearer ${nyckel}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

async function tillsKlar(nyckel, id) {
  let d;
  for (let i = 0; i < 60; i++) {
    d = (await verktyg(nyckel, 'visa_omrostning', { id })).data;
    if (!d?.pagar) return d;
    await vanta(500);
  }
  return d;
}

let testvard = null;
const kalenderStad = { nyckelId: null, userId: null, pollIds: [] };

async function del1() {
  console.log('\nDel 1: provfallet mot en tillfällig testvärd\n');
  const u = await q(
    `INSERT INTO users (slug, name, email, role, active, created_via)
     VALUES ('omrostningstest', 'Omröstningstest (tillfällig)', 'omrostningstest@example.invalid', 'host', true, 'seed')
     RETURNING id`
  );
  testvard = u.rows[0].id;
  for (let d = 1; d <= 7; d++) {
    await q('INSERT INTO availability_rules (user_id, weekday, start_min, end_min) VALUES ($1,$2,540,960)', [testvard, d]);
  }
  const L = await nycklar.skapa(testvard, { name: 'Test läs', scopes: ['las'], dagar: 1 });
  const O = await nycklar.skapa(testvard, { name: 'Test omröstning', scopes: ['omrostning'], dagar: 1 });
  const B = await nycklar.skapa(testvard, { name: 'Test boka', scopes: ['avboka', 'boka'], dagar: 1 });

  console.log('Behörigheter');
  const lasV = await verktygslista(L.nyckel);
  kolla('las ser läsverktygen för omröstningar, inga skrivverktyg',
    ['mina_omrostningar', 'omrostning_tider', 'visa_omrostning'].every((v) => lasV.includes(v)) && !lasV.includes('skapa_omrostning'), lasV);
  const omrV = await verktygslista(O.nyckel);
  kolla('omrostning ser åtta omröstningsverktyg och inga bokningsverktyg',
    omrV.length === 8 && !omrV.includes('boka') && omrV.includes('besluta_tid'), omrV);
  const bokaV = await verktygslista(B.nyckel);
  kolla('boka/avboka ser inga omröstningsverktyg', !bokaV.some((v) => /omrostning|besluta|paminn|deltagare/.test(v)), bokaV);
  kolla('läsnyckel kan inte skapa omröstning via REST (403)', (await rest(L.nyckel, '/api/admin/polls', 'POST', {})).status === 403);
  kolla('omröstningsnyckel kan inte rensa (403)', (await rest(O.nyckel, '/api/admin/polls/rensa', 'POST', {})).status === 403);

  console.log('Lediga tider');
  const fran = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  const till = new Date(Date.now() + 12 * 86400_000).toISOString().slice(0, 10);
  const t = await verktyg(L.nyckel, 'omrostning_tider', { langd_min: 60, fran, till });
  const dagar = (t.data?.dagar || []).filter((d) => d.tider.length);
  kolla('omrostning_tider ger tider med läsnyckel', dagar.length >= 4, t.fel || JSON.stringify(t.data).slice(0, 200));
  const tider = dagar.slice(0, 3).map((d) => d.tider[0].start);
  const upptagen = dagar[3].tider[0].start;

  // En bokning på den fjärde dagen gör den tiden upptagen.
  const et = await q(
    `INSERT INTO event_types (user_id, slug, title, duration_min, location_type) VALUES ($1,'test','Test',60,'other') RETURNING id`,
    [testvard]
  );
  await q(
    `INSERT INTO bookings (event_type_id, user_id, start_utc, end_utc, invitee_name, invitee_email, cancel_token, ics_uid)
     VALUES ($1,$2,$3,$3::timestamptz + interval '60 min','Upptagen','upptagen@example.invalid',md5(random()::text),md5(random()::text))`,
    [et.rows[0].id, testvard, upptagen]
  );
  const antalPolls = async () => Number((await q('SELECT count(*) FROM polls WHERE user_id = $1', [testvard])).rows[0].count);

  console.log('Skapa');
  const busy = await verktyg(O.nyckel, 'skapa_omrostning', { rubrik: 'TESTMÖTE', langd_min: 60, tider: [tider[0], upptagen] });
  kolla('upptagen tid ger ett tydligt fel', /inte ledig/.test(busy.fel || ''), busy.fel);
  kolla('… och ingenting sparas', (await antalPolls()) === 0);

  const deltagare = DELTAGARE.slice(0, 2).map((epost, i) => ({ namn: `Testdeltagare ${i + 1}`, epost, organisation: 'Test' }));
  const forhand = await verktyg(O.nyckel, 'skapa_omrostning', {
    rubrik: 'TESTMÖTE', langd_min: 60, tider, deltagare, forhandsgranska: true,
  });
  kolla('förhandsgranskning visar tider och mottagare',
    forhand.data?.forhandsgranskning === true && forhand.data.tider.length === 3 && forhand.data.inbjudan.mottagare.length === 2,
    forhand.fel || JSON.stringify(forhand.data));
  kolla('… och sparar ingenting', (await antalPolls()) === 0);

  const ref = `prov-${Date.now()}`;
  const skapad = await verktyg(O.nyckel, 'skapa_omrostning', {
    rubrik: 'TESTMÖTE', beskrivning: 'Provfall för agent-API:t. Kan ignoreras.', langd_min: 60, tider, deltagare, klient_referens: ref,
  });
  kolla('skapa_omrostning skapar och köar två inbjudningar',
    skapad.data?.skapad === true && skapad.data.pagar.inbjudningar === 2, skapad.fel || JSON.stringify(skapad.data));
  const id = skapad.data?.id;
  const igen = await verktyg(O.nyckel, 'skapa_omrostning', { rubrik: 'TESTMÖTE', langd_min: 60, tider, deltagare, klient_referens: ref });
  kolla('samma klient_referens igen ger samma omröstning, ingen dubblett',
    igen.data?.redanSkapad === true && igen.data.id === id && (await antalPolls()) === 1, igen.fel || JSON.stringify(igen.data));

  console.log('Följa upp');
  let v = await tillsKlar(L.nyckel, id);
  kolla('visa_omrostning (läsnyckel): tre tider, två inbjudna',
    v?.tider?.length === 3 && v.deltagare.filter((d) => d.inbjuden).length === 2, JSON.stringify(v));
  const restVisa = await (await rest(O.nyckel, `/api/admin/polls/${id}`)).json();
  kolla('agenten får inga personliga svarslänkar', restVisa.participants.every((p) => p.url === undefined));

  // Deltagare 1 svarar ja på tid 2, nej på övriga.
  const { rows: pp } = await q('SELECT id FROM poll_participants WHERE poll_id = $1 ORDER BY id', [id]);
  for (const [i, tid] of v.tider.entries()) {
    await q('INSERT INTO poll_votes (option_id, participant_id, answer) VALUES ($1,$2,$3)', [tid.id, pp[0].id, i === 1 ? 'ja' : 'nej']);
  }
  await q('UPDATE poll_participants SET responded_at = now() WHERE id = $1', [pp[0].id]);
  v = (await verktyg(L.nyckel, 'visa_omrostning', { id })).data;
  kolla('svaren syns per tid och vem som inte svarat', v.tider[0].ja + v.tider[1].ja + v.tider[2].ja === 1 && v.ej_svarat.length === 1, JSON.stringify(v));

  const p1 = await verktyg(O.nyckel, 'paminn', { id });
  kolla('paminn påminner den som inte svarat', p1.data?.paminda === 1, p1.fel || JSON.stringify(p1.data));
  const p2 = await verktyg(O.nyckel, 'paminn', { id });
  kolla('andra påminnelsen inom 12 timmar stoppas', /högst en gång/.test(p2.fel || ''), p2.fel);

  const tillagd = await verktyg(O.nyckel, 'lagg_till_deltagare', { id, namn: 'Testdeltagare 3', epost: DELTAGARE[2] });
  kolla('lagg_till_deltagare bjuder in direkt', tillagd.data?.inbjudanSkickad === true, tillagd.fel || JSON.stringify(tillagd.data));

  const mina = (await verktyg(L.nyckel, 'mina_omrostningar', { status: 'open' })).data;
  kolla('mina_omrostningar listar den öppna omröstningen', mina?.omrostningar?.some((p) => p.id === id && p.inbjudna === 3), JSON.stringify(mina));

  console.log('Besluta och avbryta');
  const vinnare = v.tider.find((x) => x.ja === 1);
  const beslut = await verktyg(O.nyckel, 'besluta_tid', { id, tid_id: vinnare.id });
  kolla('besluta_tid beslutar och meddelar tre deltagare',
    beslut.data?.beslutad === true && beslut.data.deltagare === 3, beslut.fel || JSON.stringify(beslut.data));
  kolla('… och syns som beslutad', (await verktyg(L.nyckel, 'visa_omrostning', { id })).data?.status === 'beslutad');
  const igenBeslut = await verktyg(O.nyckel, 'besluta_tid', { id, tid_id: vinnare.id });
  kolla('en beslutad omröstning kan inte beslutas igen', /redan beslutad/.test(igenBeslut.fel || ''), igenBeslut.fel);

  const andra = await verktyg(O.nyckel, 'skapa_omrostning', { rubrik: 'TESTMÖTE avbryts', langd_min: 60, tider: [tider[0]] });
  const avbr = await verktyg(O.nyckel, 'avbryt_omrostning', { id: andra.data?.id, orsak: 'Test' });
  kolla('avbryt_omrostning avbryter', avbr.data?.avbruten === true, avbr.fel || JSON.stringify(avbr.data));
  kolla('agenten kan inte ta bort omröstningen (403)', (await rest(O.nyckel, `/api/admin/polls/${andra.data?.id}`, 'DELETE')).status === 403);

  console.log('Takt och spårbarhet');
  // Två omröstningar är skapade; gränsen är fem per tio minuter och nyckel.
  const extra = [];
  for (let i = 0; i < 4; i++) {
    // Utan reservation, annars blockerar den första tiden för de följande.
    extra.push(await verktyg(O.nyckel, 'skapa_omrostning', { rubrik: `Taktprov ${i}`, langd_min: 60, tider: [tider[2]], reservera_kalender: false }));
  }
  kolla('den sjätte omröstningen inom tio minuter stoppas',
    extra.slice(0, 3).every((x) => x.data?.skapad) && /högst 5 omröstningar/.test(extra[3].fel || ''), JSON.stringify(extra.map((x) => x.fel || 'ok')));

  const { rows: logg } = await q(
    `SELECT action, detail FROM audit_log WHERE at > now() - interval '10 minutes'
       AND action IN ('poll_created','poll_participant_added','poll_reminded','poll_decided','poll_cancelled')
       AND (detail->>'pollId')::int IN (SELECT id FROM polls WHERE user_id = $1)`,
    [testvard]
  );
  const markta = new Set(logg.filter((r) => r.detail.viaAgent?.namn === 'Test omröstning').map((r) => r.action));
  kolla('granskningsloggen märker skapad, tillagd, påmind, beslutad och avbruten med nyckelns namn', markta.size === 5, [...markta]);
}

async function del2() {
  console.log(`\nDel 2: preliminärbokningar i kalendern för ${KALENDER} (70–90 dagar fram, inga deltagare)\n`);
  const { rows: [u] } = await q('SELECT id FROM users WHERE lower(email) = lower($1)', [KALENDER]);
  if (!kolla('användaren finns', !!u)) return;
  kalenderStad.userId = u.id;
  const K = await nycklar.skapa(u.id, { name: 'Tillfällig testnyckel (verifiera-mcp-omrostning)', scopes: ['omrostning'], dagar: 1 });
  kalenderStad.nyckelId = K.id;

  const fran = new Date(Date.now() + 70 * 86400_000).toISOString().slice(0, 10);
  const till = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);
  const t = await verktyg(K.nyckel, 'omrostning_tider', { langd_min: 60, fran, till });
  kolla('kalendern kontrollerad', t.data?.kalenderKontrollerad === true, t.fel);
  const tider = (t.data?.dagar || []).filter((d) => d.tider.length).slice(0, 3).map((d) => d.tider[0].start);
  const rubrik = `TESTMÖTE kalenderprov ${Date.now()}`;
  const s = await verktyg(K.nyckel, 'skapa_omrostning', { rubrik, langd_min: 60, tider });
  if (!kolla('omröstningen skapades', s.data?.skapad === true, s.fel)) return;
  kalenderStad.pollIds.push(s.data.id);
  const v = await tillsKlar(K.nyckel, s.data.id);
  kolla('tre preliminärbokningar i kalendern', v.tider.filter((x) => x.reserverad_i_kalendern).length === 3, JSON.stringify(v.tider));

  const { rows: [m] } = await q('SELECT refresh_token FROM ms_accounts WHERE user_id = $1', [u.id]);
  const tok = (await graph.refresh(decrypt(m.refresh_token))).access_token;
  const iKalendern = async () =>
    ((await graph.call(tok, `/me/calendarView?startDateTime=${fran}T00:00:00Z&endDateTime=${till}T23:59:59Z&$select=subject&$top=200`)).value || [])
      .filter((h) => h.subject === `Preliminär: ${rubrik}`).length;
  kolla('… och de finns i Outlook', (await iKalendern()) === 3);
  const a = await verktyg(K.nyckel, 'avbryt_omrostning', { id: s.data.id });
  kolla('avbryt släpper tre reservationer', a.data?.slapptaReservationer === 3, a.fel || JSON.stringify(a.data));
  kolla('inget kvar i Outlook', (await iKalendern()) === 0);
}

(async () => {
  try {
    await del1();
    if (KALENDER) await del2();
  } catch (err) {
    fel++;
    console.error('KRASCH', err);
  } finally {
    if (testvard) {
      await q('DELETE FROM bookings WHERE user_id = $1', [testvard]);
      await q('DELETE FROM event_types WHERE user_id = $1', [testvard]);
      await q('DELETE FROM users WHERE id = $1', [testvard]);
    }
    if (kalenderStad.pollIds.length) await q('DELETE FROM polls WHERE id = ANY($1)', [kalenderStad.pollIds]);
    if (kalenderStad.nyckelId) await q('DELETE FROM api_tokens WHERE id = $1', [kalenderStad.nyckelId]);
    const { rows: [kvar] } = await q(
      `SELECT (SELECT count(*) FROM users WHERE slug = 'omrostningstest') AS testvard,
              (SELECT count(*) FROM api_tokens WHERE name LIKE 'Test %' OR name LIKE 'Tillfällig testnyckel%') AS nycklar,
              (SELECT count(*) FROM polls WHERE title LIKE 'TESTMÖTE%' OR title LIKE 'Taktprov%') AS omrostningar`
    );
    console.log('\nStädat, kvar:', JSON.stringify(kvar));
    console.log(fel ? `\n${ok} gröna, ${fel} röda\n` : `\nAlla ${ok} kontroller gröna.\n`);
    await pool.end();
    process.exit(fel ? 1 : 0);
  }
})();
