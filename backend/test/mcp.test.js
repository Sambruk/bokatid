'use strict';
// Vilka MCP-verktyg en agentnyckel ser. Agenten ska aldrig få ett verktyg som
// nyckelns behörigheter inte täcker — och verktygen ska stämma med vad REST-
// vitlistan släpper igenom, annars ser agenten verktyg som bara ger 403.
const test = require('node:test');
const assert = require('node:assert/strict');
const { KRAV, verktygFor } = require('../lib/mcp');
const { BEHORIGHETER } = require('../lib/agent-nycklar');

const OMROSTNING_LAS = ['mina_omrostningar', 'omrostning_tider', 'visa_omrostning'];
const OMROSTNING_SKRIV = ['avbryt_omrostning', 'besluta_tid', 'lagg_till_deltagare', 'paminn', 'skapa_omrostning'];

test('läsnyckel: läsverktyg för bokningar och omröstningar, inga skrivverktyg', () => {
  assert.deepEqual(verktygFor(['las']), ['lediga_tider', 'lista_tjanster', 'mina_bokningar', ...OMROSTNING_LAS].sort());
  for (const v of OMROSTNING_SKRIV) assert.ok(!verktygFor(['las']).includes(v), v);
});

test('omrostning ensam: alla omröstningsverktyg men ingen bokning', () => {
  assert.deepEqual(verktygFor(['omrostning']), [...OMROSTNING_LAS, ...OMROSTNING_SKRIV].sort());
  for (const v of ['boka', 'avboka', 'mina_bokningar', 'lista_tjanster', 'lediga_tider']) {
    assert.ok(!verktygFor(['omrostning']).includes(v), v);
  }
});

test('boka och avboka ger inga omröstningsverktyg', () => {
  const v = verktygFor(['boka', 'avboka']);
  for (const x of [...OMROSTNING_LAS, ...OMROSTNING_SKRIV]) assert.ok(!v.includes(x), x);
});

test('alla behörigheter ger alla verktyg', () => {
  assert.deepEqual(verktygFor(Object.keys(BEHORIGHETER)), Object.keys(KRAV).sort());
});

test('varje verktyg kräver bara kända behörigheter', () => {
  for (const [verktyg, krav] of Object.entries(KRAV)) {
    assert.ok(krav.length, verktyg);
    for (const k of krav) assert.ok(Object.hasOwn(BEHORIGHETER, k), `${verktyg}: ${k}`);
  }
});

test('ingen behörighet ger inga verktyg', () => {
  assert.deepEqual(verktygFor([]), []);
});
