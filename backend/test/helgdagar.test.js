'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { paskdagen, helgdagarAr, helgdagarMellan, medHelgdagar } = require('../lib/helgdagar');

test('påskdagen för kända år', () => {
  const kanda = { 2024: '2024-03-31', 2025: '2025-04-20', 2026: '2026-04-05', 2027: '2027-03-28', 2028: '2028-04-16', 2038: '2038-04-25' };
  for (const [ar, datum] of Object.entries(kanda)) assert.strictEqual(paskdagen(Number(ar)).toISODate(), datum);
});

test('2026: alla röda dagar och aftnar', () => {
  assert.deepStrictEqual(
    helgdagarAr(2026).map((h) => `${h.datum} ${h.namn}`),
    [
      '2026-01-01 Nyårsdagen',
      '2026-01-06 Trettondedag jul',
      '2026-04-03 Långfredagen',
      '2026-04-05 Påskdagen',
      '2026-04-06 Annandag påsk',
      '2026-05-01 Första maj',
      '2026-05-14 Kristi himmelsfärdsdag',
      '2026-05-24 Pingstdagen',
      '2026-06-06 Sveriges nationaldag',
      '2026-06-19 Midsommarafton',
      '2026-06-20 Midsommardagen',
      '2026-10-31 Alla helgons dag',
      '2026-12-24 Julafton',
      '2026-12-25 Juldagen',
      '2026-12-26 Annandag jul',
      '2026-12-31 Nyårsafton',
    ]
  );
});

test('midsommar och alla helgons dag i intervallets ytterkanter', () => {
  // 2027: midsommardagen 26 juni (sista möjliga), alla helgons dag 6 nov (sista möjliga)
  const h = helgdagarAr(2027);
  assert.ok(h.some((x) => x.datum === '2027-06-26' && x.namn === 'Midsommardagen'));
  assert.ok(h.some((x) => x.datum === '2027-06-25' && x.namn === 'Midsommarafton'));
  assert.ok(h.some((x) => x.datum === '2027-11-06' && x.namn === 'Alla helgons dag'));
});

test('nationaldagen 2033 är röd även när den krockar med annandag pingst', () => {
  assert.ok(helgdagarAr(2033).some((x) => x.datum === '2033-06-06' && x.namn === 'Sveriges nationaldag'));
});

test('helgdagarMellan spänner över årsskiftet', () => {
  assert.deepStrictEqual(
    helgdagarMellan('2026-12-30', '2027-01-07').map((h) => h.datum),
    ['2026-12-31', '2027-01-01', '2027-01-06']
  );
});

test('medHelgdagar: värdens eget undantag vinner', () => {
  const egna = [{ on_date: '2026-12-24', unavailable: false, start_min: 540, end_min: 660, note: 'Jour' }];
  const ut = medHelgdagar(egna, '2026-12-23', '2026-12-26');
  assert.deepStrictEqual(ut.map((o) => [o.on_date, o.unavailable, Boolean(o.helgdag)]), [
    ['2026-12-24', false, false],
    ['2026-12-25', true, true],
    ['2026-12-26', true, true],
  ]);
});
