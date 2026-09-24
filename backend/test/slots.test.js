'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { availableSlots, isSlotAvailable, intersectDays } = require('../lib/slots');

const RULES_VARDAG = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_min: 9 * 60, end_min: 12 * 60 }));

const ET = {
  duration_min: 30,
  buffer_before: 0,
  buffer_after: 0,
  slot_step_min: 30,
  min_notice_min: 0,
  max_days_ahead: 365,
  max_per_day: null,
};

const base = {
  timezone: 'Europe/Stockholm',
  rules: RULES_VARDAG,
  overrides: [],
  eventType: ET,
  busy: [],
  now: new Date('2026-01-01T00:00:00Z'),
};

test('09:00 lokal tid är 08:00 UTC på vintern', () => {
  const [day] = availableSlots({ ...base, fromDate: '2026-01-15', toDate: '2026-01-15' });
  assert.equal(day.slots.length, 6);
  assert.equal(day.slots[0].start, '2026-01-15T08:00:00.000Z');
});

test('09:00 lokal tid är 07:00 UTC på sommaren — schemat glider inte', () => {
  const [day] = availableSlots({ ...base, fromDate: '2026-07-15', toDate: '2026-07-15' });
  assert.equal(day.slots[0].start, '2026-07-15T07:00:00.000Z');
});

test('helg ger inga tider', () => {
  const days = availableSlots({ ...base, fromDate: '2026-01-17', toDate: '2026-01-18' });
  assert.deepEqual(days.map((d) => d.slots.length), [0, 0]);
});

test('upptaget i kalendern tar bort överlappande tid, men bara den', () => {
  const busy = [{ start: '2026-01-15T09:00:00Z', end: '2026-01-15T09:30:00Z' }]; // 10:00–10:30 lokalt
  const [day] = availableSlots({ ...base, busy, fromDate: '2026-01-15', toDate: '2026-01-15' });
  const starts = day.slots.map((s) => s.start);
  assert.ok(!starts.includes('2026-01-15T09:00:00.000Z'));
  assert.ok(starts.includes('2026-01-15T09:30:00.000Z'));
  assert.equal(day.slots.length, 5);
});

test('buffert efter möte blockerar tiden närmast efter det upptagna', () => {
  const busy = [{ start: '2026-01-15T09:00:00Z', end: '2026-01-15T09:30:00Z' }];
  const eventType = { ...ET, buffer_before: 15, buffer_after: 15 };
  const [day] = availableSlots({ ...base, eventType, busy, fromDate: '2026-01-15', toDate: '2026-01-15' });
  const starts = day.slots.map((s) => s.start);
  assert.ok(!starts.includes('2026-01-15T08:30:00.000Z'), 'tiden före ska blockeras av bufferten');
  assert.ok(!starts.includes('2026-01-15T09:30:00.000Z'), 'tiden efter ska blockeras av bufferten');
  assert.ok(starts.includes('2026-01-15T08:00:00.000Z'));
});

test('framförhållning räknas från nu', () => {
  const now = new Date('2026-01-15T08:15:00Z'); // 09:15 lokalt
  const eventType = { ...ET, min_notice_min: 120 };
  const [day] = availableSlots({ ...base, now, eventType, fromDate: '2026-01-15', toDate: '2026-01-15' });
  // Nu: 09:15 lokalt. Med 2 timmars framförhållning är 11:30 den första möjliga,
  // och 12:00 ryms inte eftersom fönstret slutar 12:00.
  assert.deepEqual(day.slots.map((s) => s.start), ['2026-01-15T10:30:00.000Z']);
});

test('bokningsfönstret stänger efter max antal dagar', () => {
  const eventType = { ...ET, max_days_ahead: 7 };
  const days = availableSlots({ ...base, eventType, fromDate: '2026-01-01', toDate: '2026-01-31' });
  const withSlots = days.filter((d) => d.slots.length > 0);
  assert.equal(withSlots.at(-1).date, '2026-01-08');
});

test('datumundantag stänger dagen', () => {
  const overrides = [{ on_date: '2026-01-15', unavailable: true }];
  const [day] = availableSlots({ ...base, overrides, fromDate: '2026-01-15', toDate: '2026-01-15' });
  assert.equal(day.slots.length, 0);
});

test('datumundantag med egna tider ersätter veckoschemat', () => {
  const overrides = [{ on_date: '2026-01-15', unavailable: false, start_min: 13 * 60, end_min: 14 * 60 }];
  const [day] = availableSlots({ ...base, overrides, fromDate: '2026-01-15', toDate: '2026-01-15' });
  assert.deepEqual(day.slots.map((s) => s.start), [
    '2026-01-15T12:00:00.000Z',
    '2026-01-15T12:30:00.000Z',
  ]);
});

test('tak per dag stänger dagen när den är full', () => {
  const busy = [{ start: '2026-01-15T08:00:00Z', end: '2026-01-15T08:30:00Z' }];
  const eventType = { ...ET, max_per_day: 1 };
  const [day] = availableSlots({ ...base, eventType, busy, fromDate: '2026-01-15', toDate: '2026-01-15' });
  assert.equal(day.slots.length, 0);
});

test('dagen då klockan ställs fram ger inga tider i den överhoppade timmen', () => {
  // 29 mars 2026: 02:00 → 03:00 lokal tid. Schemalägg 01:00–05:00.
  const rules = [{ weekday: 7, start_min: 60, end_min: 5 * 60 }];
  const [day] = availableSlots({
    ...base,
    rules,
    fromDate: '2026-03-29',
    toDate: '2026-03-29',
  });
  // 02:00 och 02:30 lokalt existerar inte den natten och ska hoppas över helt,
  // inte tystas ner till dubbletter av 03:00 och 03:30.
  assert.deepEqual(day.slots.map((s) => s.start), [
    '2026-03-29T00:00:00.000Z', // 01:00 lokalt, vintertid
    '2026-03-29T00:30:00.000Z', // 01:30 lokalt, vintertid
    '2026-03-29T01:00:00.000Z', // 03:00 lokalt, sommartid
    '2026-03-29T01:30:00.000Z',
    '2026-03-29T02:00:00.000Z',
    '2026-03-29T02:30:00.000Z',
  ]);
});

test('isSlotAvailable godtar en giltig tid och avvisar en påhittad', () => {
  const p = { ...base };
  assert.equal(isSlotAvailable(p, '2026-01-15T08:00:00.000Z'), true);
  assert.equal(isSlotAvailable(p, '2026-01-15T08:07:00.000Z'), false);
  assert.equal(isSlotAvailable(p, '2026-01-17T08:00:00.000Z'), false);
});

/* ---------- snittet av flera värdars tider ---------- */

// Starttiderna i verkligheten är fullständiga UTC-tidpunkter, unika per dag.
const dag = (date, klockslag) => ({
  date,
  slots: klockslag.map((k) => ({ start: `${date}T${k}:00.000Z`, end: `${date}T${k}:00.000Z` })),
});
const klockslagen = (d) => d.slots.map((s) => s.start.slice(11, 16));

test('en enda värd ger sina egna tider oförändrade', () => {
  const in1 = [dag('2026-01-15', ['09:00', '10:00', '11:00'])];
  assert.deepEqual(intersectDays([in1]), in1);
});

test('två värdar ger bara tiderna båda har', () => {
  const ut = intersectDays([
    [dag('2026-01-15', ['09:00', '10:00', '11:00'])],
    [dag('2026-01-15', ['10:00', '11:00', '12:00'])],
  ]);
  assert.deepEqual(klockslagen(ut[0]), ['10:00', '11:00']);
});

test('en värd utan lediga tider tömmer hela tjänsten', () => {
  const ut = intersectDays([
    [dag('2026-01-15', ['09:00', '10:00'])],
    [dag('2026-01-15', [])],
  ]);
  assert.deepEqual(ut[0].slots, []);
});

test('tre värdar kräver att alla tre är lediga', () => {
  const ut = intersectDays([
    [dag('2026-01-15', ['09:00', '10:00', '11:00'])],
    [dag('2026-01-15', ['09:00', '10:00'])],
    [dag('2026-01-15', ['10:00', '11:00'])],
  ]);
  assert.deepEqual(klockslagen(ut[0]), ['10:00']);
});

test('dagar som en värd saknar helt får inga tider kvar', () => {
  const ut = intersectDays([
    [dag('2026-01-15', ['09:00']), dag('2026-01-16', ['09:00'])],
    [dag('2026-01-15', ['09:00'])],
  ]);
  assert.deepEqual(ut.map((d) => [d.date, d.slots.length]), [['2026-01-15', 1], ['2026-01-16', 0]]);
});

test('tom lista ger tom lista i stället för att krascha', () => {
  assert.deepEqual(intersectDays([]), []);
  assert.deepEqual(intersectDays(null), []);
});
