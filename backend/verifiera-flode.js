'use strict';
// Skarptest av hela kedjan mot en riktig kalender:
// boka → skrivs i Outlook → Teams-länk → tiden försvinner → avboka → borta igen.
//
// Testet gör en VERKLIG bokning och skickar VERKLIG e-post till adressen du
// anger. Bokningen avbokas och raderas automatiskt efteråt.
//
//   docker compose exec -T boka-tid-app node verifiera-flode.js --bokare namn@exempel.se
//
// Valfritt: --vard <kortnamn> --typ <motestyp> (standard: första värden och 'samtal').

const { q } = require('./lib/db');
const { decrypt } = require('./lib/crypto');
const graph = require('./lib/graph');

const BAS = 'http://127.0.0.1:3000';

const arg = (namn, standard) => {
  const i = process.argv.indexOf(`--${namn}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : standard;
};
const VARD = arg('vard', null);
const TYP = arg('typ', 'samtal');
const BOKARE = arg('bokare', null);

if (!BOKARE || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(BOKARE)) {
  console.error('\nAnge vem testbokningen ska skickas till:');
  console.error('  node verifiera-flode.js --bokare namn@exempel.se\n');
  console.error('Testet skickar verklig e-post till adressen, och avbokar sedan bokningen.\n');
  process.exit(1);
}

const rad = (ok, text, extra) => {
  console.log(`${ok ? '  OK  ' : ' FEL  '} ${text}${extra ? ' — ' + extra : ''}`);
  return ok ? 0 : 1;
};

async function token() {
  const { rows } = await q('SELECT refresh_token FROM ms_accounts LIMIT 1');
  const d = await graph.refresh(decrypt(rows[0].refresh_token));
  return d.access_token;
}

(async () => {
  let fel = 0;

  const vard = VARD || (await q('SELECT slug FROM users WHERE active ORDER BY id LIMIT 1')).rows[0]?.slug;
  if (!vard) {
    rad(false, 'Ingen värd finns i tjänsten');
    process.exit(1);
  }

  // Hämta lediga tider tre veckor fram, för att inte krocka med riktiga möten.
  const fran = new Date(Date.now() + 21 * 86400_000).toISOString().slice(0, 10);
  const till = new Date(Date.now() + 26 * 86400_000).toISOString().slice(0, 10);
  const tider = await (await fetch(`${BAS}/api/slots/${vard}/${TYP}?from=${fran}&to=${till}`)).json();
  fel += rad(tider.calendarChecked === true, 'Lediga tider räknas fram med kalendern inräknad',
    `calendarChecked=${tider.calendarChecked}`);

  const dag = (tider.days || []).find((d) => d.slots.length);
  if (!dag) {
    rad(false, 'Inga lediga tider att testa med');
    process.exit(1);
  }
  const tid = dag.slots[0];
  console.log(`\nTestar med ${dag.label} ${tid.label} (${tid.start})\n`);

  // Boka.
  const svar = await (
    await fetch(`${BAS}/api/book/${vard}/${TYP}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        start: tid.start,
        name: 'Skarptest Boka tid',
        email: BOKARE,
        org: 'Sambruk',
        answers: { 'Vad vill du prata om?': 'Teknisk kontroll, kan ignoreras' },
      }),
    })
  ).json();

  if (!svar.ok) {
    rad(false, 'Bokningen misslyckades', svar.error);
    process.exit(1);
  }
  fel += rad(svar.booking.calendarWritten === true, 'Mötet skrevs till Outlook-kalendern');
  fel += rad(Boolean(svar.booking.joinUrl), 'Teams-länk följde med bokningen');
  fel += rad(svar.booking.mailAccepted === true, 'Bekräftelse skickades med e-post');

  const { rows } = await q('SELECT * FROM bookings ORDER BY id DESC LIMIT 1');
  const bokning = rows[0];
  fel += rad(Boolean(bokning.graph_event_id), 'Kalenderhändelsens id sparades i databasen');

  // Finns mötet verkligen i kalendern?
  const t1 = await token();
  let handelse;
  try {
    handelse = await graph.call(t1, `/me/events/${encodeURIComponent(bokning.graph_event_id)}`);
    fel += rad(true, 'Mötet finns i kalendern', `rubrik: ${handelse.subject}`);
    fel += rad(Boolean(handelse.isOnlineMeeting), 'Mötet är markerat som onlinemöte');
    const deltagare = (handelse.attendees || []).map((a) => a.emailAddress.address);
    fel += rad(deltagare.includes(BOKARE), 'Bokaren står som deltagare', deltagare.join(', '));
  } catch (err) {
    fel += rad(false, 'Mötet kunde inte hittas i kalendern', err.message);
  }

  // Är tiden borta ur de lediga tiderna nu?
  const efter = await (await fetch(`${BAS}/api/slots/${vard}/${TYP}?from=${fran}&to=${till}`)).json();
  const finnsKvar = (efter.days || []).some((d) => d.slots.some((s) => s.start === tid.start));
  fel += rad(!finnsKvar, 'Den bokade tiden erbjuds inte längre');

  // Avboka via samma länk som bokaren får.
  const avbokat = await (
    await fetch(`${BAS}/api/booking/${bokning.cancel_token}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'boka-tid' },
      body: JSON.stringify({ reason: 'Skarptest, avbokas automatiskt' }),
    })
  ).json();
  fel += rad(avbokat.ok === true, 'Avbokningen gick igenom');

  const t2 = await token();
  try {
    const kvar = await graph.call(t2, `/me/events/${encodeURIComponent(bokning.graph_event_id)}?$select=id,isCancelled`);
    fel += rad(Boolean(kvar.isCancelled), 'Mötet är markerat som avbokat i kalendern',
      kvar.isCancelled ? null : 'ligger kvar som aktivt');
  } catch (err) {
    fel += rad(err.status === 404, 'Mötet är borta ur kalendern', err.status === 404 ? null : err.message);
  }

  const { rows: slut } = await q('SELECT status FROM bookings WHERE id = $1', [bokning.id]);
  fel += rad(slut[0].status === 'cancelled', 'Bokningen är avbokad i databasen');

  // Städa bort testbokningen.
  await q('DELETE FROM bookings WHERE id = $1', [bokning.id]);
  rad(true, 'Testbokningen raderad ur databasen');

  console.log(fel ? `\n${fel} fel.\n` : '\nHela kedjan fungerar.\n');
  process.exit(fel ? 1 : 0);
})().catch((err) => {
  console.error('Testet kraschade:', err);
  process.exit(1);
});
