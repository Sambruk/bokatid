// Texten i värdens kalenderhändelse byggs av det bokaren skriver in. Allt
// måste escapas, annars kan en bokare lägga egen HTML i värdens kalender.
const test = require('node:test');
const assert = require('node:assert');
const { bookingEventHtml } = require('../lib/mail');

const booking = { invitee_name: 'Anna Andersson', invitee_email: 'anna@kommun.se', invitee_org: 'Kommunen' };

test('vanlig bokning ger namn, adress, organisation och svar', () => {
  const html = bookingEventHtml({ booking, answers: { 'Vad vill du prata om?': 'Budget' }, cancelUrl: 'https://app.sambruk.se/boka/avboka/abc' });
  assert.match(html, /<a href="https:\/\/app\.sambruk\.se\/boka\/avboka\/abc">/);
  assert.match(html, /Anna Andersson &lt;anna@kommun\.se&gt; \(Kommunen\)/);
  assert.match(html, /<strong>Vad vill du prata om\?:<\/strong> Budget/);
});

test('HTML från bokaren escapas i namn, organisation, frågor och svar', () => {
  const ond = '<a href="https://ond.example">Klicka</a><img src=x onerror=alert(1)>';
  const html = bookingEventHtml({
    booking: { invitee_name: ond, invitee_email: 'a@b.se', invitee_org: ond },
    answers: { [ond]: ond },
    cancelUrl: 'https://app.sambruk.se/boka/avboka/abc',
  });
  assert.doesNotMatch(html, /ond\.example">/);
  assert.doesNotMatch(html, /<img/);
  assert.strictEqual(html.match(/<a /g).length, 1, 'bara avbokningslänken får vara en länk');
  assert.match(html, /&lt;a href=&quot;https:\/\/ond\.example&quot;&gt;/);
});

test('organisation utelämnas när den saknas', () => {
  const html = bookingEventHtml({ booking: { ...booking, invitee_org: null }, answers: {}, cancelUrl: 'u' });
  assert.match(html, /anna@kommun\.se&gt;<\/p>$/);
});
