// Deltagarens preliminära bokningar (kvittots kalenderfil) kan Boka inte ta
// bort — Exchange godtar inte en avbokning från oss för poster deltagaren själv
// lagt in (provat 2026-11-11). Därför ska varje besked säga exakt vilka tider
// deltagaren ska ta bort, och beslutsbeskedet ha den slutliga tiden som fil.
const test = require('node:test');
const assert = require('node:assert');
const nodemailer = require('nodemailer');

const skickade = [];
test.mock.method(nodemailer, 'createTransport', () => ({ sendMail: async (m) => skickade.push(m) }));
process.env.SMTP_HOST = 'test.invalid';
const mail = require('../lib/mail');

const poll = { id: 62, title: 'Test <möte>', location_type: 'other', location_text: 'Rum 1' };
const host = { name: 'Thomas', email: 'thomas@sambruk.se' };
const o = (id, h) => ({ id, start_utc: `2026-11-27T${h}:00:00Z`, end_utc: `2026-11-27T${h}:30:00Z` });
const [a, b, c] = [o(1, '07'), o(2, '08'), o(3, '09')];
const mats = { id: 7, name: 'Mats', email: 'mats@exempel.se' };
const anna = { id: 8, name: 'Anna', email: 'anna@exempel.se' };

test('listan sorteras, escapas och är tom utan tider', () => {
  assert.strictEqual(mail.preliminarLista([], 'x'), '');
  const html = mail.preliminarLista([c, a], 'Ta bort <dessa>:');
  assert.ok(html.indexOf('08:00') < html.indexOf('10:00'), 'sorterad på tid');
  assert.match(html, /Ta bort &lt;dessa&gt;:/);
});

test('kvittot säger att man tar bort själv och listar strukna tider', async () => {
  skickade.length = 0;
  await mail.sendPollVoteReceipt({ poll, host, participant: mats, val: [{ option: a, answer: 'ja' }], url: 'https://x', struknaTider: [c] });
  const m = skickade[0];
  assert.match(m.html, /du tar bort dem själv/);
  assert.match(m.html, /Ta bort preliminära bokningar[\s\S]*10:00/);
  assert.match(m.attachments[0].content, /UID:poll-62-opt-1-p7@boka\.sambruk\.se/);
});

test('beslutet: slutlig tid som fil med Outlooks UID, och var och ens egna preliminära tider', async () => {
  skickade.length = 0;
  await mail.sendPollDecision({
    poll, host, option: a, participants: [mats, anna], joinUrl: null, withIcs: true,
    icsUid: 'AAA-outlook-uid', preliminara: new Map([[7, [a, b]]]),
  });
  const [tillMats, tillAnna] = skickade;
  assert.match(tillMats.html, /Ta bort preliminära bokningar[\s\S]*08:00[\s\S]*09:00/);
  assert.match(tillMats.html, /även den tid som blev vald/);
  assert.match(tillMats.html, /mote\.ics/);
  // Bara som bifogad fil: som mötesförfrågan med Outlooks UID sväljer Exchange mejlet.
  assert.strictEqual(tillMats.icalEvent, undefined);
  const fil = tillMats.attachments.find((x) => x.filename === 'mote.ics');
  assert.match(fil.contentType, /method=PUBLISH/);
  assert.match(fil.content, /METHOD:PUBLISH/);
  assert.match(fil.content, /UID:AAA-outlook-uid/);
  assert.match(fil.content, /ORGANIZER;CN=Thomas:mailto:thomas@sambruk\.se/);
  assert.doesNotMatch(tillAnna.html, /Ta bort preliminära/, 'den som inte fått tider får ingen lista');
});

test('utan Outlook-möte är vår fil den riktiga inbjudan', async () => {
  skickade.length = 0;
  await mail.sendPollDecision({ poll, host, option: a, participants: [mats], joinUrl: null, withIcs: true });
  assert.match(skickade[0].icalEvent.content, /METHOD:REQUEST/);
});

test('avbrottet listar de preliminära tiderna', async () => {
  skickade.length = 0;
  await mail.sendPollCancelled({ poll, host, participants: [mats], reason: 'Sjuk', preliminara: new Map([[7, [b]]]) });
  assert.match(skickade[0].html, /Ta bort preliminära bokningar[\s\S]*09:00/);
});
