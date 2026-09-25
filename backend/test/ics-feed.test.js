'use strict';
// Tolkningen av en prenumererad kalender. Den här koden avgör om en extern parts
// bokade tider syns som upptagna — missas ett återkommande möte visas en bokad
// tid som ledig, och två personer hamnar på samma tid.

const test = require('node:test');
const assert = require('node:assert');
const { tolkaIcs, privatAdress, kontrolleraAdress } = require('../lib/ics-feed');

const kalender = (...rader) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//SV', ...rader, 'END:VCALENDAR'].join('\r\n');

const vevent = (rader) => ['BEGIN:VEVENT', 'UID:' + Math.random(), ...rader, 'END:VEVENT'];

const fonster = { fromIso: '2026-10-01T00:00:00Z', toIso: '2026-10-31T23:59:59Z' };

test('ett enkelt möte blir en upptagen tid', () => {
  const ics = kalender(
    ...vevent(['DTSTART:20261005T080000Z', 'DTEND:20261005T090000Z', 'SUMMARY:Möte'])
  );
  assert.deepEqual(tolkaIcs(ics, fonster), [
    { start: '2026-10-05T08:00:00.000Z', end: '2026-10-05T09:00:00.000Z' },
  ]);
});

test('tid markerad som ledig blockerar inte', () => {
  const ics = kalender(
    ...vevent(['DTSTART:20261005T080000Z', 'DTEND:20261005T090000Z', 'TRANSP:TRANSPARENT'])
  );
  assert.deepEqual(tolkaIcs(ics, fonster), []);
});

test('inställt möte blockerar inte', () => {
  const ics = kalender(
    ...vevent(['DTSTART:20261005T080000Z', 'DTEND:20261005T090000Z', 'STATUS:CANCELLED'])
  );
  assert.deepEqual(tolkaIcs(ics, fonster), []);
});

test('Outlooks egen ledigmarkering respekteras', () => {
  const ics = kalender(
    ...vevent([
      'DTSTART:20261005T080000Z',
      'DTEND:20261005T090000Z',
      'X-MICROSOFT-CDO-BUSYSTATUS:FREE',
    ])
  );
  assert.deepEqual(tolkaIcs(ics, fonster), []);
});

test('veckovis återkommande möte vecklas ut över hela fönstret', () => {
  const ics = kalender(
    ...vevent([
      'DTSTART:20261001T070000Z',
      'DTEND:20261001T073000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=TH',
      'SUMMARY:Veckomöte',
    ])
  );
  const ut = tolkaIcs(ics, fonster);
  // Torsdagar i oktober 2026: 1, 8, 15, 22, 29.
  assert.equal(ut.length, 5, `förväntade 5 förekomster, fick ${ut.length}`);
  assert.equal(ut[0].start, '2026-10-01T07:00:00.000Z');
  assert.equal(ut.at(-1).start, '2026-10-29T07:00:00.000Z');
});

test('undantag i en serie (EXDATE) blockerar inte', () => {
  const ics = kalender(
    ...vevent([
      'DTSTART:20261001T070000Z',
      'DTEND:20261001T073000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=TH',
      'EXDATE:20261015T070000Z',
    ])
  );
  const ut = tolkaIcs(ics, fonster);
  assert.equal(ut.length, 4);
  assert.ok(!ut.some((b) => b.start.startsWith('2026-10-15')), 'undantagna 15 oktober ska vara borta');
});

test('serie med slutdatum tar slut', () => {
  const ics = kalender(
    ...vevent([
      'DTSTART:20261001T070000Z',
      'DTEND:20261001T073000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261016T000000Z',
    ])
  );
  assert.equal(tolkaIcs(ics, fonster).length, 3); // 1, 8, 15 oktober
});

test('lokal tid med tidszon tolkas till rätt UTC-tid', () => {
  const ics = kalender(
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Stockholm',
    'BEGIN:STANDARD',
    'DTSTART:19701025T030000',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:19700329T020000',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
    ...vevent(['DTSTART;TZID=Europe/Stockholm:20261005T100000', 'DTEND;TZID=Europe/Stockholm:20261005T110000'])
  );
  const ut = tolkaIcs(ics, fonster);
  // 10:00 svensk sommartid = 08:00 UTC.
  assert.equal(ut[0].start, '2026-10-05T08:00:00.000Z');
});

test('kalender med enbart radmatning (LF) tolkas ändå', () => {
  const ics = kalender(...vevent(['DTSTART:20261005T080000Z', 'DTEND:20261005T090000Z'])).replace(/\r\n/g, '\n');
  assert.equal(tolkaIcs(ics, fonster).length, 1, 'LF-radbrytningar ska inte få tolkningen att brista');
});

test('blandade radbrytningar tolkas', () => {
  const ics = kalender(...vevent(['DTSTART:20261005T080000Z', 'DTEND:20261005T090000Z'])).replace(
    'BEGIN:VEVENT\r\n',
    'BEGIN:VEVENT\n'
  );
  assert.equal(tolkaIcs(ics, fonster).length, 1);
});

test('överlappande möten slås ihop till ett intervall', () => {
  const ics = kalender(
    ...vevent(['DTSTART:20261005T080000Z', 'DTEND:20261005T090000Z']),
    ...vevent(['DTSTART:20261005T083000Z', 'DTEND:20261005T100000Z'])
  );
  assert.deepEqual(tolkaIcs(ics, fonster), [
    { start: '2026-10-05T08:00:00.000Z', end: '2026-10-05T10:00:00.000Z' },
  ]);
});

test('möten utanför fönstret tas inte med', () => {
  const ics = kalender(
    ...vevent(['DTSTART:20260901T080000Z', 'DTEND:20260901T090000Z']),
    ...vevent(['DTSTART:20261201T080000Z', 'DTEND:20261201T090000Z'])
  );
  assert.deepEqual(tolkaIcs(ics, fonster), []);
});

/* ---------- skyddet mot att peka inåt ---------- */

test('privata och lokala adresser känns igen', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.17.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1']) {
    assert.equal(privatAdress(ip), true, `${ip} ska räknas som intern`);
  }
  for (const ip of ['8.8.8.8', '91.107.206.3', '2606:4700::1111']) {
    assert.equal(privatAdress(ip), false, `${ip} ska räknas som extern`);
  }
});

test('adress till dockerns eget nät avvisas', async () => {
  await assert.rejects(() => kontrolleraAdress('http://172.17.0.1:13900/boka/'), /internt nät/);
});

test('adress som inte är webbadress avvisas', async () => {
  await assert.rejects(() => kontrolleraAdress('file:///etc/passwd'), /https/);
  await assert.rejects(() => kontrolleraAdress('inte en adress'), /giltig webbadress/);
});
