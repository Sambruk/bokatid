'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { nyNyckel, lasBearer, tolkaNyNyckel, behorighetForRutt, tillater, STANDARD_DAGAR, MAX_DAGAR } = require('../lib/agent-nycklar');
const { hashToken } = require('../lib/crypto');

test('ny nyckel: prefix bt_, hashen är SHA-256 av nyckeln, prefixet avslöjar inte nyckeln', () => {
  const a = nyNyckel();
  const b = nyNyckel();
  assert.match(a.nyckel, /^bt_[A-Za-z0-9_-]{43}$/);
  assert.equal(a.hash, hashToken(a.nyckel));
  assert.equal(a.prefix, a.nyckel.slice(0, 10));
  assert.notEqual(a.nyckel, b.nyckel);
});

test('Bearer-headern: bara bt_-nycklar tolkas, annat lämnas åt andra', () => {
  assert.equal(lasBearer('Bearer bt_abc'), 'bt_abc');
  assert.equal(lasBearer('bearer   bt_abc  '), 'bt_abc');
  assert.equal(lasBearer('Bearer eyJhbGciOi'), null);
  assert.equal(lasBearer('Basic dXNlcjpwYXNz'), null);
  assert.equal(lasBearer('bt_abc'), null);
  assert.equal(lasBearer(undefined), null);
  assert.equal(lasBearer('Bearer bt_a bt_b'), null);
});

test('ny nyckel: namn, behörigheter och giltighetstid kontrolleras', () => {
  assert.ok(tolkaNyNyckel({ scopes: ['las'] }).fel);
  assert.ok(tolkaNyNyckel({ name: 'Eneo', scopes: [] }).fel);
  assert.ok(tolkaNyNyckel({ name: 'Eneo', scopes: ['admin'] }).fel);
  assert.ok(tolkaNyNyckel({ name: 'Eneo', scopes: ['__proto__'] }).fel);
  assert.ok(tolkaNyNyckel({ name: 'Eneo', scopes: ['las'], dagar: 0 }).fel);
  assert.ok(tolkaNyNyckel({ name: 'Eneo', scopes: ['las'], dagar: MAX_DAGAR + 1 }).fel);
  assert.ok(tolkaNyNyckel({ name: 'Eneo', scopes: ['las'], dagar: 'många' }).fel);

  const ok = tolkaNyNyckel({ name: '  Eneo  ', scopes: ['boka', 'las', 'las'] });
  assert.deepEqual(ok, { name: 'Eneo', scopes: ['boka', 'las'], dagar: STANDARD_DAGAR });
});

test('agenter släpps bara in på vitlistade admin-rutter', () => {
  assert.deepEqual(behorighetForRutt('GET', '/api/admin/bookings'), ['las']);
  assert.deepEqual(behorighetForRutt('POST', '/api/admin/bookings/:id/cancel'), ['avboka']);
  assert.equal(behorighetForRutt('POST', '/api/admin/bookings'), null);
  assert.equal(behorighetForRutt('PUT', '/api/admin/password'), null);
  assert.equal(behorighetForRutt('POST', '/api/admin/agentnycklar'), null);
  assert.equal(behorighetForRutt('GET', '/api/admin/users'), null);
  assert.equal(behorighetForRutt('GET', undefined), null);
});

test('omröstningar: läsa med las eller omrostning, ändra bara med omrostning', () => {
  for (const vag of ['/api/admin/poll-slots', '/api/admin/polls', '/api/admin/polls/:id']) {
    const krav = behorighetForRutt('GET', vag);
    assert.ok(tillater(['las'], krav), `las ska räcka för GET ${vag}`);
    assert.ok(tillater(['omrostning'], krav), `omrostning ska räcka för GET ${vag}`);
    assert.ok(!tillater(['boka', 'avboka'], krav), `boka/avboka ska inte räcka för GET ${vag}`);
  }
  for (const vag of ['/api/admin/polls', '/api/admin/polls/:id/participants', '/api/admin/polls/:id/remind',
    '/api/admin/polls/:id/decide', '/api/admin/polls/:id/cancel']) {
    const krav = behorighetForRutt('POST', vag);
    assert.ok(tillater(['omrostning'], krav), `omrostning ska räcka för POST ${vag}`);
    assert.ok(!tillater(['las', 'boka', 'avboka'], krav), `las/boka/avboka ska inte räcka för POST ${vag}`);
  }
  // Ta bort, rensa, stänga och öppna igen är inte öppna för agenter.
  assert.equal(behorighetForRutt('DELETE', '/api/admin/polls/:id'), null);
  assert.equal(behorighetForRutt('POST', '/api/admin/polls/rensa'), null);
  assert.equal(behorighetForRutt('POST', '/api/admin/polls/:id/close'), null);
  assert.equal(behorighetForRutt('POST', '/api/admin/polls/:id/reopen'), null);
});

test('omrostning är en giltig behörighet för nya nycklar', () => {
  assert.deepEqual(tolkaNyNyckel({ name: 'AIPL', scopes: ['omrostning', 'las'] }).scopes, ['las', 'omrostning']);
});
