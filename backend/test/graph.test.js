'use strict';
// Tolkningen av Graphs ledig/upptaget. Den här koden hade en tyst bugg i drift:
// en global Prefer-header fick Graph att svara i svensk tid medan svaret
// tolkades som UTC. Upptagna tider förskjöts två timmar, så bokade tider
// visades som lediga. Testerna nedan finns för att det inte ska upprepas.

const test = require('node:test');
const assert = require('node:assert');

process.env.TOKEN_KEY = process.env.TOKEN_KEY || 'a'.repeat(64);
const { tolkaSchema } = require('../lib/graph');

const post = (status, start, slut, timeZone = 'UTC') => ({
  status,
  start: { dateTime: start, timeZone },
  end: { dateTime: slut, timeZone },
});

test('UTC-svar tolkas rakt av', () => {
  const ut = tolkaSchema([post('busy', '2026-09-25T11:00:00.0000000', '2026-09-25T12:00:00.0000000')]);
  assert.deepEqual(ut, [{ start: '2026-09-25T11:00:00Z', end: '2026-09-25T12:00:00Z' }]);
});

test('ett svar i lokal tid KASTAR i stället för att tolkas som UTC', () => {
  assert.throws(
    () =>
      tolkaSchema([
        post('busy', '2026-09-25T13:00:00.0000000', '2026-09-25T14:00:00.0000000', 'W. Europe Standard Time'),
      ]),
    /tidszonen/i,
    'en tidszon som inte är UTC måste ge ett fel — annars blockeras fel tider'
  );
});

test('upptagna statusar blockerar, ledig gör det inte', () => {
  const items = [
    post('busy', '2026-09-25T08:00:00', '2026-09-25T09:00:00'),
    post('tentative', '2026-09-25T09:00:00', '2026-09-25T10:00:00'),
    post('oof', '2026-09-25T10:00:00', '2026-09-25T11:00:00'),
    post('workingElsewhere', '2026-09-25T11:00:00', '2026-09-25T12:00:00'),
    post('free', '2026-09-25T12:00:00', '2026-09-25T13:00:00'),
    post('unknown', '2026-09-25T13:00:00', '2026-09-25T14:00:00'),
  ];
  const ut = tolkaSchema(items);
  assert.equal(ut.length, 4, 'free och unknown ska inte blockera');
  assert.equal(ut[0].start, '2026-09-25T08:00:00Z');
});

test('mellanslag i stället för T i tidsangivelsen hanteras', () => {
  const ut = tolkaSchema([post('busy', '2026-09-25 11:00:00.0000000', '2026-09-25 12:00:00.0000000')]);
  assert.deepEqual(ut, [{ start: '2026-09-25T11:00:00Z', end: '2026-09-25T12:00:00Z' }]);
});

test('tom lista ger tom lista', () => {
  assert.deepEqual(tolkaSchema([]), []);
});
