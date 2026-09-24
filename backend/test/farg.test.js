'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tema, kontrast, parseHex, KRAV_TEXT } = require('../lib/farg');

test('känd kontrast: svart mot vitt är 21:1', () => {
  assert.equal(Math.round(kontrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })), 21);
});

test('Sambruks gröna klarar inte textkravet och mörknas', () => {
  const t = tema('#58A618');
  assert.ok(t.kontrastVald < KRAV_TEXT, `förväntade under ${KRAV_TEXT}, fick ${t.kontrastVald}`);
  assert.equal(t.justerad, true);
  assert.ok(t.kontrastText >= KRAV_TEXT, `textfärgen ska klara kravet, fick ${t.kontrastText}`);
  assert.equal(t.dekor, '#58a618', 'originalfärgen behålls för dekor');
});

test('en färg som redan klarar kravet lämnas orörd', () => {
  const t = tema('#1f5c99');
  assert.ok(t.kontrastVald >= KRAV_TEXT);
  assert.equal(t.justerad, false);
  assert.equal(t.text, t.vald);
});

test('mycket ljus färg mörknas tillräckligt', () => {
  const t = tema('#ffee00');
  assert.ok(t.kontrastText >= KRAV_TEXT, `fick ${t.kontrastText}`);
});

test('kort hex och versaler tolkas', () => {
  assert.deepEqual(parseHex('#FFF'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseHex('58A618'), { r: 88, g: 166, b: 24 });
});

test('ogiltig färg ger null i stället för ett trasigt tema', () => {
  assert.equal(tema('rödaktig'), null);
  assert.equal(tema('#12345'), null);
  assert.equal(tema(''), null);
  assert.equal(tema(null), null);
});
