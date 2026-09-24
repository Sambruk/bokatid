'use strict';
// E-post via Postal, med kalenderfil bifogad.
// Postal här tar inte emot STARTTLS från klienter, därför secure: false och
// ingen tvingad TLS-uppgradering. Trafiken går på dockerns interna nät.
const nodemailer = require('nodemailer');
const { formatSwedish } = require('./slots');

const TZ = 'Europe/Stockholm';

function transport() {
  if (!process.env.SMTP_HOST) return null;
  const auth = process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 25),
    secure: false,
    ignoreTLS: !auth,
    auth,
  });
}

function sender() {
  const name = process.env.SMTP_SENDER_NAME || 'Sambruk';
  const addr = process.env.SMTP_SENDER || 'noreply@sambruk.se';
  return `"${name}" <${addr}>`;
}

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ICS-fältvärden: radbrytningar och kommatecken måste escapas, annars bryts filen.
const icsText = (s) =>
  String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/([,;])/g, '\\$1');

const icsStamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** METHOD:REQUEST för bokning, CANCEL för avbokning. */
function buildIcs({ booking, host, eventType, method = 'REQUEST' }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sambruk//Boka tid//SV',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${booking.ics_uid}`,
    `SEQUENCE:${booking.ics_sequence || 0}`,
    `DTSTAMP:${icsStamp(new Date().toISOString())}`,
    `DTSTART:${icsStamp(booking.start_utc)}`,
    `DTEND:${icsStamp(booking.end_utc)}`,
    `SUMMARY:${icsText(eventType.title)}`,
    `ORGANIZER;CN=${icsText(host.name)}:mailto:${host.email}`,
    `ATTENDEE;CN=${icsText(booking.invitee_name)};ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${booking.invitee_email}`,
    `STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
  ];
  const place = booking.join_url || eventType.location_text;
  if (place) lines.push(`LOCATION:${icsText(place)}`);
  const desc = [eventType.description, booking.join_url ? `Anslut: ${booking.join_url}` : null]
    .filter(Boolean)
    .join('\n\n');
  if (desc) lines.push(`DESCRIPTION:${icsText(desc)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

function locationLine(booking, eventType) {
  if (booking.join_url) return `Teams-möte: ${booking.join_url}`;
  switch (eventType.location_type) {
    case 'teams':
      return 'Teams-möte. Länk kommer i kalenderinbjudan.';
    case 'phone':
      return `Telefon: ${eventType.location_text || 'värden ringer upp'}`;
    case 'physical':
      return `Plats: ${eventType.location_text || 'meddelas separat'}`;
    default:
      return eventType.location_text || '';
  }
}

async function sendBookingMails({ booking, host, eventType, cancelUrl, withIcs = true, tillBokaren = true }) {
  const tp = transport();
  if (!tp) return { sent: false, reason: 'SMTP_HOST saknas' };

  const when = formatSwedish(new Date(booking.start_utc).toISOString(), new Date(booking.end_utc).toISOString(), TZ);
  const place = locationLine(booking, eventType);
  // Är mötet redan skrivet i värdens M365-kalender har Outlook skickat den
  // riktiga inbjudan. Då bifogar vi ingen egen kalenderfil: två inbjudningar
  // för samma möte ger dubbletter i bokarens kalender.
  const ics = buildIcs({ booking, host, eventType, method: 'REQUEST' });
  const invite = withIcs
    ? {
        attachments: [
          { filename: 'mote.ics', content: ics, contentType: 'text/calendar; charset=utf-8; method=REQUEST' },
        ],
        icalEvent: { method: 'REQUEST', content: ics },
      }
    : {};

  const inviteeHtml = `
    <p>Hej ${esc(booking.invitee_name)},</p>
    <p>Din tid är bokad.</p>
    <table cellpadding="4">
      <tr><th align="left">Möte</th><td>${esc(eventType.title)}</td></tr>
      <tr><th align="left">När</th><td>${esc(when)} (svensk tid)</td></tr>
      <tr><th align="left">Med</th><td>${esc(host.name)}${host.title ? ', ' + esc(host.title) : ''}</td></tr>
      ${place ? `<tr><th align="left">Var</th><td>${esc(place)}</td></tr>` : ''}
    </table>
    <p>Behöver du avboka gör du det här: <a href="${esc(cancelUrl)}">${esc(cancelUrl)}</a></p>
    <p>Hälsningar<br>Sambruk</p>`;

  const hostHtml = `
    <p>Ny bokning: <strong>${esc(eventType.title)}</strong></p>
    <table cellpadding="4">
      <tr><th align="left">När</th><td>${esc(when)}</td></tr>
      <tr><th align="left">Bokare</th><td>${esc(booking.invitee_name)} &lt;${esc(booking.invitee_email)}&gt;</td></tr>
      ${booking.invitee_org ? `<tr><th align="left">Organisation</th><td>${esc(booking.invitee_org)}</td></tr>` : ''}
    </table>
    ${answersHtml(booking.answers)}`;

  const utskick = [];
  // Bokaren får bara mail från oss när Outlook inte redan skickat en inbjudan.
  if (tillBokaren) {
    utskick.push(
      tp.sendMail({
        from: sender(),
        to: `"${booking.invitee_name}" <${booking.invitee_email}>`,
        subject: `Bekräftelse: ${eventType.title} — ${when}`,
        html: inviteeHtml,
        ...invite,
      })
    );
  }
  const results = await Promise.allSettled([
    ...utskick,
    tp.sendMail({
      from: sender(),
      to: host.email,
      subject: `Ny bokning: ${eventType.title} — ${when}`,
      html: hostHtml,
    }),
  ]);
  const failed = results.filter((r) => r.status === 'rejected');
  return { sent: failed.length === 0, errors: failed.map((f) => String(f.reason && f.reason.message)) };
}

async function sendCancellationMails({ booking, host, eventType, reason, cancelledBy, withIcs = true }) {
  const tp = transport();
  if (!tp) return { sent: false, reason: 'SMTP_HOST saknas' };
  const when = formatSwedish(new Date(booking.start_utc).toISOString(), new Date(booking.end_utc).toISOString(), TZ);
  const ics = buildIcs({ booking, host, eventType, method: 'CANCEL' });
  const invite = withIcs
    ? {
        attachments: [
          { filename: 'avbokning.ics', content: ics, contentType: 'text/calendar; charset=utf-8; method=CANCEL' },
        ],
        icalEvent: { method: 'CANCEL', content: ics },
      }
    : {};
  const html = `
    <p>Mötet <strong>${esc(eventType.title)}</strong> ${esc(when)} är avbokat.</p>
    ${reason ? `<p>Angiven orsak: ${esc(reason)}</p>` : ''}
    <p>Avbokat av ${cancelledBy === 'host' ? esc(host.name) : esc(booking.invitee_name)}.</p>`;

  const results = await Promise.allSettled([
    tp.sendMail({
      from: sender(),
      to: `"${booking.invitee_name}" <${booking.invitee_email}>`,
      subject: `Avbokat: ${eventType.title} — ${when}`,
      html,
      ...invite,
    }),
    tp.sendMail({ from: sender(), to: host.email, subject: `Avbokat: ${eventType.title} — ${when}`, html }),
  ]);
  const failed = results.filter((r) => r.status === 'rejected');
  return { sent: failed.length === 0, errors: failed.map((f) => String(f.reason && f.reason.message)) };
}

/* ---------- omröstningar ---------- */

const tidRad = (o) => formatSwedish(new Date(o.start_utc).toISOString(), new Date(o.end_utc).toISOString(), TZ);

/** Inbjudan att svara på en omröstning. Ingen kalenderfil: tiden är inte beslutad. */
async function sendPollInvitation({ poll, host, participant, url, options }) {
  const tp = transport();
  if (!tp) return { sent: false, reason: 'SMTP_HOST saknas' };

  const tider = options.map((o) => `<li>${esc(tidRad(o))}</li>`).join('');
  const html = `
    <p>Hej ${esc(participant.name)},</p>
    <p>${esc(host.name)} vill boka <strong>${esc(poll.title)}</strong> och behöver veta
       vilka tider som fungerar för dig.</p>
    ${poll.description ? `<p>${esc(poll.description)}</p>` : ''}
    <p><a href="${esc(url)}">Svara här</a><br>
       <span style="color:#53605a">${esc(url)}</span></p>
    <p>Föreslagna tider (svensk tid), mötet är ${esc(String(poll.duration_min))} minuter:</p>
    <ul>${tider}</ul>
    ${poll.deadline ? `<p>Svara gärna senast ${esc(formatSwedish(new Date(poll.deadline).toISOString(), new Date(poll.deadline).toISOString(), TZ).split(',')[0])}.</p>` : ''}
    <p>Du får en kalenderinbjudan när tiden är bestämd.</p>
    <p>Hälsningar<br>${esc(host.name)} via Sambruk</p>`;

  try {
    await tp.sendMail({
      from: sender(),
      to: `"${participant.name}" <${participant.email}>`,
      subject: `Vilka tider passar dig? ${poll.title}`,
      html,
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, errors: [String(err.message)] };
  }
}

/**
 * Besked om att tiden är beslutad. Skapades mötet i värdens kalender skickar
 * Outlook den riktiga inbjudan till deltagarna, och då bifogas ingen egen
 * kalenderfil här.
 */
async function sendPollDecision({ poll, host, option, participants, joinUrl, withIcs, baraBesked = false }) {
  const tp = transport();
  if (!tp) return { sent: false, reason: 'SMTP_HOST saknas' };

  const when = tidRad(option);
  const plats = joinUrl
    ? `Teams-möte: ${joinUrl}`
    : locationLine({}, { location_type: poll.location_type, location_text: poll.location_text });

  const resultat = await Promise.allSettled(
    participants.map((p) => {
      const ics = withIcs
        ? buildIcs({
            booking: {
              ics_uid: `poll-${poll.id}-${option.id}@boka.sambruk.se`,
              ics_sequence: 0,
              start_utc: option.start_utc,
              end_utc: option.end_utc,
              invitee_name: p.name,
              invitee_email: p.email,
              join_url: joinUrl,
            },
            host,
            eventType: {
              title: poll.title,
              description: poll.description,
              location_type: poll.location_type,
              location_text: poll.location_text,
            },
            method: 'REQUEST',
          })
        : null;

      return tp.sendMail({
        from: sender(),
        to: `"${p.name}" <${p.email}>`,
        subject: `${baraBesked ? 'Beslutad tid' : 'Tiden är bestämd'}: ${poll.title} — ${when}`,
        html: `
          <p>Hej ${esc(p.name)},</p>
          <p>Tiden för <strong>${esc(poll.title)}</strong> är nu bestämd:</p>
          <p><strong>${esc(when)}</strong> (svensk tid)</p>
          ${plats ? `<p>${esc(plats)}</p>` : ''}
          ${
            baraBesked
              ? '<p>Det här är bara ett besked om tiden — du är inte inbjuden till mötet.</p>'
              : '<p>Tack för ditt svar.</p>'
          }
          <p>Hälsningar<br>${esc(host.name)} via Sambruk</p>`,
        ...(ics
          ? {
              attachments: [
                { filename: 'mote.ics', content: ics, contentType: 'text/calendar; charset=utf-8; method=REQUEST' },
              ],
              icalEvent: { method: 'REQUEST', content: ics },
            }
          : {}),
      });
    })
  );
  const failed = resultat.filter((r) => r.status === 'rejected');
  return { sent: failed.length === 0, errors: failed.map((f) => String(f.reason && f.reason.message)) };
}

/** Besked om att omröstningen avbrutits. */
async function sendPollCancelled({ poll, host, participants, reason }) {
  const tp = transport();
  if (!tp) return { sent: false, reason: 'SMTP_HOST saknas' };
  const resultat = await Promise.allSettled(
    participants.map((p) =>
      tp.sendMail({
        from: sender(),
        to: `"${p.name}" <${p.email}>`,
        subject: `Inställt: ${poll.title}`,
        html: `
          <p>Hej ${esc(p.name)},</p>
          <p>Omröstningen om tid för <strong>${esc(poll.title)}</strong> är avbruten,
             och något möte bokas inte utifrån den.</p>
          ${reason ? `<p>Angiven orsak: ${esc(reason)}</p>` : ''}
          <p>Hälsningar<br>${esc(host.name)} via Sambruk</p>`,
      })
    )
  );
  const failed = resultat.filter((r) => r.status === 'rejected');
  return { sent: failed.length === 0, errors: failed.map((f) => String(f.reason && f.reason.message)) };
}

function answersHtml(answers) {
  const entries = Object.entries(answers || {});
  if (!entries.length) return '';
  return `<p>Svar på frågor:</p><ul>${entries
    .map(([k, v]) => `<li><strong>${esc(k)}:</strong> ${esc(v)}</li>`)
    .join('')}</ul>`;
}

module.exports = {
  sendBookingMails,
  sendCancellationMails,
  sendPollInvitation,
  sendPollDecision,
  sendPollCancelled,
  buildIcs,
  locationLine,
};
