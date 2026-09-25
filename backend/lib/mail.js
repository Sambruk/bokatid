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

/** Återställningslänk för lösenord. Skickas bara till kontots egen adress. */
async function sendPasswordReset({ user, url, giltigMinuter = 60 }) {
  const tp = transport();
  if (!tp) return { sent: false, reason: 'SMTP_HOST saknas' };
  try {
    await tp.sendMail({
      from: sender(),
      to: `"${user.name}" <${user.email}>`,
      subject: 'Återställ ditt lösenord — Boka tid',
      html: `
        <p>Hej ${esc(user.name)},</p>
        <p>Någon har begärt ett nytt lösenord för ditt konto i Boka tid. Klicka på
           länken nedan för att välja ett nytt. Länken gäller i ${esc(String(giltigMinuter))} minuter
           och kan bara användas en gång.</p>
        <p><a href="${esc(url)}">Välj nytt lösenord</a><br>
           <span style="color:#53605a">${esc(url)}</span></p>
        <p>Var det inte du behöver du inte göra något — lösenordet ändras inte
           förrän någon använder länken. Men hör gärna av dig till oss om du inte
           känner igen begäran.</p>
        <p>Hälsningar<br>Sambruk</p>`,
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, errors: [String(err.message)] };
  }
}

/**
 * Besked till en medvärd om att ett möte bokats, med kalenderfil.
 *
 * Skrevs mötet i ägarens kalender har Outlook redan bjudit in medvärden, och
 * kalenderfilen bär då SAMMA id som Outlooks möte — annars hade den hamnat som
 * en dubblett bredvid inbjudan. För en extern part, vars kalender vi aldrig kan
 * skriva i, är filen ofta det enda sättet att få in mötet.
 */
async function sendCoHostNotice({ booking, host, coHost, eventType, cancelUrl }) {
  const tp = transport();
  if (!tp) return { sent: false, reason: 'SMTP_HOST saknas' };

  const when = formatSwedish(new Date(booking.start_utc).toISOString(), new Date(booking.end_utc).toISOString(), TZ);
  const plats = locationLine(booking, eventType);
  const ics = buildIcs({ booking, host, eventType, method: 'REQUEST' });

  const html = `
    <p>Hej ${esc(coHost.name)},</p>
    <p>Ett möte är bokat där du är med som värd.</p>
    <table cellpadding="4">
      <tr><th align="left">Möte</th><td>${esc(eventType.title)}</td></tr>
      <tr><th align="left">När</th><td>${esc(when)} (svensk tid)</td></tr>
      <tr><th align="left">Bokare</th><td>${esc(booking.invitee_name)} &lt;${esc(booking.invitee_email)}&gt;</td></tr>
      ${booking.invitee_org ? `<tr><th align="left">Organisation</th><td>${esc(booking.invitee_org)}</td></tr>` : ''}
      <tr><th align="left">Värd</th><td>${esc(host.name)}</td></tr>
      ${plats ? `<tr><th align="left">Var</th><td>${esc(plats)}</td></tr>` : ''}
    </table>
    ${answersHtml(booking.answers)}
    <p>Bifogad kalenderfil lägger in mötet i din kalender.</p>
    ${cancelUrl ? `<p>Behöver mötet avbokas: <a href="${esc(cancelUrl)}">${esc(cancelUrl)}</a></p>` : ''}`;

  try {
    await tp.sendMail({
      from: sender(),
      to: `"${coHost.name}" <${coHost.email}>`,
      subject: `Bokat möte: ${eventType.title} — ${when}`,
      html,
      attachments: [
        { filename: 'mote.ics', content: ics, contentType: 'text/calendar; charset=utf-8; method=REQUEST' },
      ],
      icalEvent: { method: 'REQUEST', content: ics },
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, errors: [String(err.message)] };
  }
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
 * Kvitto till den som svarat: vilka tider hen valde, och en kalenderfil som
 * lägger in dem som PRELIMINÄRA i den egna kalendern. Metoden är PUBLISH och
 * inte REQUEST — det här är inte en inbjudan utan deltagarens egen reservation,
 * och tiden är ännu inte bestämd.
 */
async function sendPollVoteReceipt({ poll, host, participant, val, kanskeText = 'Om jag måste', url }) {
  const tp = transport();
  if (!tp) return { sent: false, reason: 'SMTP_HOST saknas' };

  const etikett = { ja: 'Ja', kanske: kanskeText, nej: 'Nej' };
  const rader = val
    .map((v) => `<tr><td>${esc(tidRad(v.option))}</td><td>${esc(etikett[v.answer] || v.answer)}</td></tr>`)
    .join('');

  // Bara tider deltagaren kan komma på reserveras — ett nej ska inte hamna i
  // kalendern.
  const attReservera = val.filter((v) => v.answer !== 'nej').map((v) => v.option);
  const ics = attReservera.length ? buildTentativeIcs({ poll, host, participant, options: attReservera }) : null;

  const html = `
    <p>Hej ${esc(participant.name)},</p>
    <p>Tack för ditt svar om tid för <strong>${esc(poll.title)}</strong>. Så här svarade du:</p>
    <table cellpadding="4" border="0">
      <tr><th align="left">Tid</th><th align="left">Ditt svar</th></tr>
      ${rader}
    </table>
    ${
      ics
        ? `<p>Bifogat ligger en kalenderfil med de tider du kan. Öppna den om du vill
           lägga in dem som <strong>preliminära</strong> i din egen kalender, så att ingen
           annan bokar dem under tiden. Den som inte blir av tar du bort själv.</p>`
        : ''
    }
    <p>Vill du ändra ditt svar går det bra fram till att tiden bestäms:<br>
       <a href="${esc(url)}">${esc(url)}</a></p>
    <p>Du får besked när tiden är bestämd.</p>
    <p>Hälsningar<br>${esc(host.name)} via Sambruk</p>`;

  try {
    await tp.sendMail({
      from: sender(),
      to: `"${participant.name}" <${participant.email}>`,
      subject: `Ditt svar om tid: ${poll.title}`,
      html,
      ...(ics
        ? {
            attachments: [
              {
                filename: 'preliminara-tider.ics',
                content: ics,
                contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
              },
            ],
          }
        : {}),
    });
    return { sent: true, reserverade: attReservera.length };
  } catch (err) {
    return { sent: false, errors: [String(err.message)] };
  }
}

/** En kalenderfil med flera preliminära poster, en per vald tid. */
function buildTentativeIcs({ poll, host, participant, options }) {
  const rader = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sambruk//Boka tid//SV',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  for (const o of options) {
    rader.push(
      'BEGIN:VEVENT',
      `UID:poll-${poll.id}-opt-${o.id}-p${participant.id}@boka.sambruk.se`,
      `DTSTAMP:${icsStamp(new Date().toISOString())}`,
      `DTSTART:${icsStamp(o.start_utc)}`,
      `DTEND:${icsStamp(o.end_utc)}`,
      `SUMMARY:${icsText('Preliminär: ' + poll.title)}`,
      `DESCRIPTION:${icsText(
        `Föreslagen tid i en omröstning från ${host.name}. Tiden är inte bestämd ännu.`
      )}`,
      'STATUS:TENTATIVE',
      // Outlook och Google läser olika fält för "preliminär".
      'X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE',
      'TRANSP:OPAQUE',
      'END:VEVENT'
    );
  }
  rader.push('END:VCALENDAR');
  return rader.join('\r\n');
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
  sendPasswordReset,
  sendCoHostNotice,
  sendPollVoteReceipt,
  buildTentativeIcs,
  sendBookingMails,
  sendCancellationMails,
  sendPollInvitation,
  sendPollDecision,
  sendPollCancelled,
  buildIcs,
  locationLine,
};
