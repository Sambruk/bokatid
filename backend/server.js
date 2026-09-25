'use strict';
// Boka tid — server. Publik bokning + admin för värden.
// Öppen källkod, byggd för svensk offentlig sektor.

const express = require('express');
const path = require('path');
const { DateTime } = require('luxon');

const { pool, q, waitForDatabase, applySchema, seed, audit } = require('./lib/db');
const { availableSlots, isSlotAvailable, intersectDays, formatSwedish } = require('./lib/slots');
const { encrypt, decrypt, verifyPassword, hashPassword, randomToken, hashToken, pkce } = require('./lib/crypto');
const graph = require('./lib/graph');
const mail = require('./lib/mail');
const { gallra, startaGallring, inställningar: gallringInst } = require('./lib/gallring');

const PORT = Number(process.env.PORT || 3000);
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const TZ = 'Europe/Stockholm';
const SESSION_COOKIE = 'boka_session';
const SESSION_DAYS = 7;

/**
 * Domäner vars användare får skapa konto själva genom att logga in med Microsoft.
 * Appregistreringen är enkel-tenant, så bara Sambruks katalog kan autentisera —
 * men en katalog kan ha gästkonton från andra organisationer, och de ska inte
 * kunna lägga upp sig som värdar. Därav den här listan.
 */
const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS ||
  (process.env.ADMIN_EMAIL || '').split('@')[1] || '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const domainAllowed = (email) => {
  const domain = String(email || '').split('@')[1]?.toLowerCase();
  return Boolean(domain) && ALLOWED_DOMAINS.includes(domain);
};

const app = express();
app.set('trust proxy', true);
// Loggan skickas som base64 och behöver mer utrymme än övriga anrop. Gränsen
// höjs bara för den vägen, inte för hela API:t.
app.use((req, res, next) =>
  express.json({ limit: req.path.endsWith('/organization/logo') ? '3mb' : '64kb' })(req, res, next)
);

const router = express.Router();

/* ---------- hjälpare ---------- */

const bad = (res, code, msg) => res.status(code).json({ error: msg });
const isEmail = (s) => typeof s === 'string' && /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(s.trim()) && s.length <= 254;
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Enkel takgräns i minnet. Räcker för en tjänst av denna storlek; vid flera
// instanser behöver den flyttas till databasen.
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now > rec.reset) {
    hits.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  rec.n += 1;
  return rec.n <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
}, 60_000).unref();

async function currentUser(req) {
  const token = cookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const { rows } = await q(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now() AND u.active`,
    [token]
  );
  return rows[0] || null;
}

async function requireAuth(req, res, next) {
  const user = await currentUser(req);
  if (!user) return bad(res, 401, 'Inte inloggad');
  // Skydd mot förfrågningar från andra webbplatser: admin-API:t kräver en
  // header som ett vanligt formulär på en främmande sida inte kan sätta.
  if (req.method !== 'GET' && req.get('x-requested-with') !== 'boka-tid') {
    return bad(res, 403, 'Saknar x-requested-with');
  }
  req.user = user;
  next();
}

/** Giltigt åtkomsttoken för Graph, förnyat vid behov. Null om värden inte kopplat M365. */
async function accessTokenFor(userId) {
  if (!graph.isConfigured()) return null;
  const { rows } = await q('SELECT * FROM ms_accounts WHERE user_id = $1', [userId]);
  const acct = rows[0];
  if (!acct || !acct.refresh_token) return null;

  const fresh = acct.expires_at && new Date(acct.expires_at).getTime() - Date.now() > 120_000;
  if (fresh && acct.access_token) return { token: decrypt(acct.access_token), upn: acct.ms_upn };

  try {
    const data = await graph.refresh(decrypt(acct.refresh_token));
    await q(
      `UPDATE ms_accounts SET access_token = $2, refresh_token = COALESCE($3, refresh_token),
         expires_at = now() + ($4 || ' seconds')::interval, last_error = NULL, updated_at = now()
       WHERE user_id = $1`,
      [userId, encrypt(data.access_token), data.refresh_token ? encrypt(data.refresh_token) : null, String(data.expires_in || 3600)]
    );
    return { token: data.access_token, upn: acct.ms_upn };
  } catch (err) {
    await q('UPDATE ms_accounts SET last_error = $2, updated_at = now() WHERE user_id = $1', [
      userId,
      String(err.message).slice(0, 500),
    ]);
    await audit('system', 'ms_refresh_failed', { userId, error: String(err.message) });
    return null;
  }
}

/**
 * All upptagen tid för en värd i ett intervall: egna bokningar ur databasen och,
 * om M365 är kopplat, ledig/upptaget ur kalendern. Går Graph-anropet fel
 * används bara databasen — hellre en tid som råkar krocka än en tjänst som
 * slutar visa tider helt.
 */
async function busyFor(user, fromIso, toIso, { ignorePollId = null } = {}) {
  const { rows } = await q(
    `SELECT b.start_utc AS start, b.end_utc AS end FROM bookings b
     WHERE b.status = 'confirmed' AND b.end_utc > $2 AND b.start_utc < $3
       AND (b.user_id = $1 OR EXISTS (
         SELECT 1 FROM booking_hosts bh WHERE bh.booking_id = b.id AND bh.user_id = $1))`,
    [user.id, fromIso, toIso]
  );
  const busy = rows.map((r) => ({ start: r.start, end: r.end }));

  /*
   * Omröstningarnas tider blockeras också: varje öppet förslag är en
   * preliminärbokning, och en beslutad tid är ett riktigt möte. De ligger även i
   * M365-kalendern, men databasen är källan som gäller även när kopplingen är
   * nere — annars kunde någon boka bort en tid som redan är reserverad.
   * ignorePollId används när en omröstning själv räknar fram sina tider.
   */
  const { rows: pollRader } = await q(
    `SELECT o.start_utc AS start, o.end_utc AS end
     FROM poll_options o JOIN polls p ON p.id = o.poll_id
     WHERE p.user_id = $1 AND o.end_utc > $2 AND o.start_utc < $3
       AND ($4::int IS NULL OR p.id <> $4)
       AND (
         (p.status = 'open' AND p.hold_calendar)
         OR (p.status = 'decided' AND o.id = p.decided_option)
       )`,
    [user.id, fromIso, toIso, ignorePollId]
  );
  busy.push(...pollRader.map((r) => ({ start: r.start, end: r.end })));

  const auth = await accessTokenFor(user.id);
  if (auth) {
    try {
      const fromGraph = await graph.busyIntervals(auth.token, { upn: auth.upn || user.email, fromIso, toIso });
      busy.push(...fromGraph);
      return { busy, calendarChecked: true };
    } catch (err) {
      await audit('system', 'graph_freebusy_failed', { userId: user.id, error: String(err.message) });
    }
  }
  return { busy, calendarChecked: false };
}

async function loadSchedule(user) {
  const [rules, overrides] = await Promise.all([
    q('SELECT weekday, start_min, end_min FROM availability_rules WHERE user_id = $1 ORDER BY weekday, start_min', [user.id]),
    q("SELECT to_char(on_date,'YYYY-MM-DD') AS on_date, unavailable, start_min, end_min, note FROM date_overrides WHERE user_id = $1 AND on_date >= current_date - 1 ORDER BY on_date", [user.id]),
  ]);
  return { rules: rules.rows, overrides: overrides.rows };
}

async function findHostAndEvent(hostSlug, eventSlug) {
  const { rows } = await q(
    `SELECT e.*, u.id AS host_id, u.name AS host_name, u.email AS host_email,
            u.title AS host_title, u.slug AS host_slug, u.timezone
     FROM event_types e JOIN users u ON u.id = e.user_id
     WHERE u.slug = $1 AND e.slug = $2 AND e.active AND u.active`,
    [hostSlug, eventSlug]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  const host = {
    id: r.host_id,
    name: r.host_name,
    email: r.host_email,
    title: r.host_title,
    slug: r.host_slug,
    timezone: r.timezone,
  };
  return { host, eventType: r, hosts: await hostsFor(r.id, host) };
}

/**
 * Samtliga värdar på en bokningstjänst: ägaren först, sedan medvärdarna.
 * Inaktiva användare utesluts — annars skulle en avstängd kollega tysta ner
 * alla tider, eftersom snittet kräver att var och en är ledig.
 */
async function hostsFor(eventTypeId, owner) {
  const { rows } = await q(
    `SELECT u.id, u.name, u.email, u.title, u.slug, u.timezone
     FROM event_type_hosts h JOIN users u ON u.id = h.user_id
     WHERE h.event_type_id = $1 AND u.active AND u.id <> $2
     ORDER BY u.name`,
    [eventTypeId, owner.id]
  );
  return [owner, ...rows];
}

/**
 * Lediga tider för flera värdar = snittet. En tid erbjuds bara när varje värd
 * är ledig då, både enligt sitt veckoschema och enligt sin kalender.
 */
async function slotsForHosts({ hosts, eventType, tz, fromDate, toDate, fromIso, toIso }) {
  const perVard = [];
  let calendarChecked = true;

  for (const host of hosts) {
    const { rules, overrides } = await loadSchedule(host);
    const { busy, calendarChecked: last } = await busyFor(host, fromIso, toIso);
    if (!last) calendarChecked = false;
    perVard.push(availableSlots({ timezone: tz, rules, overrides, eventType, busy, fromDate, toDate }));
  }

  return { days: intersectDays(perVard), calendarChecked };
}

const publicEventType = (e) => ({
  slug: e.slug,
  title: e.title,
  description: e.description,
  duration_min: e.duration_min,
  location_type: e.location_type,
  location_text: e.location_type === 'physical' ? e.location_text : null,
  questions: e.questions,
  max_days_ahead: e.max_days_ahead,
});

/* ---------- publikt API ---------- */

router.get('/healthz', async (req, res) => {
  try {
    await q('SELECT 1');
    res.json({ ok: true, now: new Date().toISOString(), m365: graph.isConfigured() ? 'konfigurerad' : 'ej konfigurerad' });
  } catch (err) {
    res.status(503).json({ ok: false, error: String(err.message) });
  }
});

router.get('/api/hosts', async (req, res) => {
  const { rows } = await q(
    `SELECT u.slug, u.name, u.title,
            COALESCE(json_agg(json_build_object('slug', e.slug, 'title', e.title,
              'duration_min', e.duration_min) ORDER BY e.title)
              FILTER (WHERE e.id IS NOT NULL), '[]') AS event_types
     FROM users u LEFT JOIN event_types e ON e.user_id = u.id AND e.active
     WHERE u.active GROUP BY u.id ORDER BY u.name`
  );
  res.json({ hosts: rows, today: DateTime.now().setZone(TZ).setLocale('sv').toFormat('cccc d LLLL yyyy') });
});

/**
 * Översikt över allt som går att boka i organisationen.
 * Tjänster med en enda värd hör till den personen; tjänster med flera värdar
 * står för sig, eftersom de inte tillhör någon enskild.
 */
router.get('/api/oversikt', async (req, res) => {
  const { rows } = await q(
    `SELECT e.slug, e.title, e.description, e.duration_min, e.location_type,
            u.slug AS host_slug, u.name AS host_name, u.title AS host_title,
            COALESCE(
              (SELECT json_agg(json_build_object('name', hu.name, 'title', hu.title) ORDER BY hu.name)
               FROM event_type_hosts h JOIN users hu ON hu.id = h.user_id
               WHERE h.event_type_id = e.id AND hu.active AND hu.id <> u.id),
              '[]') AS medvardar
     FROM event_types e JOIN users u ON u.id = e.user_id
     WHERE e.active AND u.active
     ORDER BY u.name, e.title`
  );

  const personer = new Map();
  const grupp = [];

  for (const r of rows) {
    const tjanst = {
      slug: r.slug,
      title: r.title,
      description: r.description,
      duration_min: r.duration_min,
      location_type: r.location_type,
      hostSlug: r.host_slug,
    };

    if (r.medvardar.length) {
      grupp.push({
        ...tjanst,
        hosts: [{ name: r.host_name, title: r.host_title }, ...r.medvardar],
      });
      continue;
    }

    if (!personer.has(r.host_slug)) {
      personer.set(r.host_slug, {
        slug: r.host_slug,
        name: r.host_name,
        title: r.host_title,
        eventTypes: [],
      });
    }
    personer.get(r.host_slug).eventTypes.push(tjanst);
  }

  res.json({
    personer: [...personer.values()],
    grupp,
    today: DateTime.now().setZone(TZ).setLocale('sv').toFormat('cccc d LLLL yyyy'),
  });
});

router.get('/api/event-type/:hostSlug/:eventSlug', async (req, res) => {
  const found = await findHostAndEvent(req.params.hostSlug, req.params.eventSlug);
  if (!found) return bad(res, 404, 'Mötestypen finns inte');
  res.json({
    host: { name: found.host.name, title: found.host.title, slug: found.host.slug },
    hosts: found.hosts.map((h) => ({ name: h.name, title: h.title })),
    eventType: publicEventType(found.eventType),
    timezone: found.host.timezone,
    today: DateTime.now().setZone(TZ).setLocale('sv').toFormat('cccc d LLLL yyyy'),
  });
});

router.get('/api/slots/:hostSlug/:eventSlug', async (req, res) => {
  const found = await findHostAndEvent(req.params.hostSlug, req.params.eventSlug);
  if (!found) return bad(res, 404, 'Mötestypen finns inte');
  const { host, eventType } = found;

  const tz = host.timezone || TZ;
  const today = DateTime.now().setZone(tz).startOf('day');
  let from = DateTime.fromISO(str(req.query.from, 10), { zone: tz });
  if (!from.isValid) from = today;
  if (from < today) from = today;
  let to = DateTime.fromISO(str(req.query.to, 10), { zone: tz });
  if (!to.isValid) to = from.plus({ days: 13 });
  // Taket hindrar att någon begär ett år i taget och drar igång tunga Graph-anrop.
  if (to > from.plus({ days: 30 })) to = from.plus({ days: 30 });
  const maxDate = today.plus({ days: eventType.max_days_ahead });
  if (to > maxDate) to = maxDate;
  if (to < from) return res.json({ days: [], calendarChecked: false });

  const { days, calendarChecked } = await slotsForHosts({
    hosts: found.hosts,
    eventType,
    tz,
    fromDate: from.toISODate(),
    toDate: to.toISODate(),
    fromIso: from.startOf('day').toUTC().toISO(),
    toIso: to.endOf('day').toUTC().toISO(),
  });

  res.json({
    days: days.map((d) => ({
      date: d.date,
      label: DateTime.fromISO(d.date, { zone: tz }).setLocale('sv').toFormat('cccc d LLLL'),
      slots: d.slots.map((s) => ({
        start: s.start,
        end: s.end,
        label: DateTime.fromISO(s.start, { zone: 'utc' }).setZone(tz).toFormat('HH:mm'),
      })),
    })),
    calendarChecked,
    timezone: tz,
    maxDate: maxDate.toISODate(),
  });
});

router.post('/api/book/:hostSlug/:eventSlug', async (req, res) => {
  const ip = req.ip || 'okänd';
  if (!rateLimit(`book:${ip}`, 10, 10 * 60_000)) return bad(res, 429, 'För många bokningsförsök. Försök igen senare.');

  const found = await findHostAndEvent(req.params.hostSlug, req.params.eventSlug);
  if (!found) return bad(res, 404, 'Mötestypen finns inte');
  const { host, eventType } = found;

  const name = str(req.body?.name, 120);
  const email = str(req.body?.email, 254);
  const org = str(req.body?.org, 160);
  const startIso = str(req.body?.start, 40);
  if (name.length < 2) return bad(res, 400, 'Ange ditt namn');
  if (!isEmail(email)) return bad(res, 400, 'Ange en giltig e-postadress');

  const start = DateTime.fromISO(startIso, { zone: 'utc' });
  if (!start.isValid) return bad(res, 400, 'Ogiltig tid');
  const end = start.plus({ minutes: eventType.duration_min });

  const answers = {};
  for (const question of eventType.questions || []) {
    const val = str(req.body?.answers?.[question.key], 2000);
    if (question.required && !val) return bad(res, 400, `Fyll i: ${question.key}`);
    if (val) answers[question.key] = val;
  }

  const tz = host.timezone || TZ;
  const fromIso = start.minus({ days: 1 }).toISO();
  const toIso = end.plus({ days: 1 }).toISO();

  // Varje värd måste vara ledig. Räcker det inte för en av dem är tiden borta.
  for (const enHost of found.hosts) {
    const { rules, overrides } = await loadSchedule(enHost);
    const { busy } = await busyFor(enHost, fromIso, toIso);
    const ok = isSlotAvailable({ timezone: tz, rules, overrides, eventType, busy }, start.toUTC().toISO());
    if (!ok) {
      return bad(
        res,
        409,
        found.hosts.length > 1
          ? `Tiden är inte längre ledig hos ${enHost.name}. Välj en annan tid.`
          : 'Tiden är inte längre ledig. Välj en annan tid.'
      );
    }
  }

  const cancelToken = randomToken(24);
  const icsUid = `${randomToken(12)}@boka.sambruk.se`;
  let booking;
  try {
    const { rows } = await q(
      `INSERT INTO bookings (event_type_id, user_id, start_utc, end_utc, invitee_name,
         invitee_email, invitee_org, answers, cancel_token, ics_uid)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [eventType.id, host.id, start.toUTC().toISO(), end.toUTC().toISO(), name, email, org || null, JSON.stringify(answers), cancelToken, icsUid]
    );
    booking = rows[0];
  } catch (err) {
    // 23505 = unik nyckel: två personer klickade på samma tid samtidigt.
    if (err.code === '23505') return bad(res, 409, 'Tiden blev bokad av någon annan. Välj en annan tid.');
    if (err.code === '23503') return bad(res, 400, 'Mötestypen finns inte längre');
    if (err.code === '23514') return bad(res, 400, 'Ogiltiga värden');
    throw err;
  }

  // Alla värdar knyts till bokningen, så tiden blockeras för var och en även
  // om någon av dem saknar kalenderkoppling.
  for (const enHost of found.hosts) {
    await q('INSERT INTO booking_hosts (booking_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
      booking.id,
      enHost.id,
    ]);
  }

  // Skriv in mötet i värdens M365-kalender. Lyckas det skickar M365 inbjudan,
  // och då bifogar vi ingen egen kalenderfil — annars får bokaren två.
  let calendarWritten = false;
  const auth = await accessTokenFor(host.id);
  if (auth) {
    try {
      const created = await graph.createEvent(auth.token, {
        subject: `${eventType.title} — ${name}`,
        bodyHtml: bookingBodyHtml({ booking, eventType, answers, cancelUrl: cancelUrl(cancelToken) }),
        startIso: start.toUTC().toISO(),
        endIso: end.toUTC().toISO(),
        inviteeEmail: email,
        inviteeName: name,
        // Medvärdarna bjuds in som deltagare i samma möte.
        extraAttendees: found.hosts.filter((h) => h.id !== host.id).map((h) => ({ address: h.email, name: h.name })),
        locationType: eventType.location_type,
        locationText: eventType.location_text,
        transactionId: icsUid,
      });
      await q('UPDATE bookings SET graph_event_id = $2, join_url = $3 WHERE id = $1', [
        booking.id,
        created.id,
        created.joinUrl,
      ]);
      booking.graph_event_id = created.id;
      booking.join_url = created.joinUrl;
      calendarWritten = true;
    } catch (err) {
      await audit('system', 'graph_create_failed', { bookingId: booking.id, error: String(err.message) });
    }
  }

  /*
   * Ett mail per person, samma regel som för omröstningarna. Skrevs mötet i
   * värdens kalender skickar Outlook inbjudan till bokaren, och då skickar vi
   * ingen egen bekräftelse — avbokningslänken ligger överst i händelsens text.
   * Värdens eget "ny bokning"-mail är ingen dubblett: värden är organisatör och
   * får ingen inbjudan från Outlook.
   */
  const mailResult = await mail.sendBookingMails({
    booking,
    host,
    eventType,
    cancelUrl: cancelUrl(cancelToken),
    withIcs: !calendarWritten,
    tillBokaren: !calendarWritten,
  });

  // mailAccepted betyder att e-postservern tog emot meddelandet — inte att det
  // levererades till inkorgen. Skillnaden gjorde ett leveransfel osynligt en hel
  // dag, så flaggan ska inte läsas som en leveransgaranti.
  await audit(email, 'booking_created', {
    bookingId: booking.id,
    calendarWritten,
    mailAccepted: mailResult.sent,
    mailErrors: mailResult.sent ? undefined : mailResult.errors || mailResult.reason,
  });

  res.status(201).json({
    ok: true,
    booking: {
      when: formatSwedish(new Date(booking.start_utc).toISOString(), new Date(booking.end_utc).toISOString(), tz),
      joinUrl: booking.join_url,
      location: mail.locationLine(booking, eventType),
      cancelUrl: cancelUrl(cancelToken),
      calendarWritten,
      mailAccepted: mailResult.sent,
      // Sant när Outlooks inbjudan är bokarens besked och vi inte skickat eget mail.
      beskedViaOutlook: calendarWritten,
    },
  });
});

const cancelUrl = (token) => `${PUBLIC_URL}/avboka/${token}`;

function bookingBodyHtml({ booking, eventType, answers, cancelUrl: url }) {
  const rows = Object.entries(answers || {})
    .map(([k, v]) => `<p><strong>${k}:</strong> ${v}</p>`)
    .join('');
  // Avbokningslänken står först: den här texten är det enda bokaren får när
  // Outlook sköter inbjudan, så länken måste vara lätt att hitta.
  return (
    `<p><strong>Behöver du avboka eller boka om?</strong><br>` +
    `<a href="${url}">${url}</a></p>` +
    `<p>Bokad via Boka tid.</p>` +
    `<p>${booking.invitee_name} &lt;${booking.invitee_email}&gt;${
      booking.invitee_org ? ` (${booking.invitee_org})` : ''
    }</p>${rows}`
  );
}

/* ---------- avbokning ---------- */

router.get('/api/booking/:token', async (req, res) => {
  const { rows } = await q(
    `SELECT b.*, e.title, e.description, e.location_type, e.location_text,
            u.name AS host_name, u.email AS host_email, u.title AS host_title, u.timezone
     FROM bookings b JOIN event_types e ON e.id = b.event_type_id JOIN users u ON u.id = b.user_id
     WHERE b.cancel_token = $1`,
    [str(req.params.token, 80)]
  );
  const b = rows[0];
  if (!b) return bad(res, 404, 'Bokningen finns inte');
  res.json({
    status: b.status,
    title: b.title,
    when: formatSwedish(new Date(b.start_utc).toISOString(), new Date(b.end_utc).toISOString(), b.timezone || TZ),
    host: { name: b.host_name, title: b.host_title },
    invitee: { name: b.invitee_name, email: b.invitee_email },
    location: mail.locationLine(b, b),
    joinUrl: b.join_url,
    inPast: new Date(b.start_utc) < new Date(),
  });
});

router.post('/api/booking/:token/cancel', async (req, res) => {
  if (!rateLimit(`cancel:${req.ip}`, 20, 10 * 60_000)) return bad(res, 429, 'För många försök');
  const token = str(req.params.token, 80);
  const reason = str(req.body?.reason, 500);
  const { rows } = await q(
    `SELECT b.*, e.title, e.description, e.location_type, e.location_text,
            u.id AS host_id, u.name AS host_name, u.email AS host_email, u.title AS host_title, u.timezone
     FROM bookings b JOIN event_types e ON e.id = b.event_type_id JOIN users u ON u.id = b.user_id
     WHERE b.cancel_token = $1`,
    [token]
  );
  const b = rows[0];
  if (!b) return bad(res, 404, 'Bokningen finns inte');
  if (b.status === 'cancelled') return res.json({ ok: true, alreadyCancelled: true });

  await cancelBooking(b, { by: 'invitee', reason });
  res.json({ ok: true });
});

async function cancelBooking(b, { by, reason }) {
  await q(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2,
       cancel_reason = $3, ics_sequence = ics_sequence + 1 WHERE id = $1`,
    [b.id, by, reason || null]
  );

  const host = { id: b.host_id || b.user_id, name: b.host_name, email: b.host_email, title: b.host_title };
  let calendarCancelled = false;
  if (b.graph_event_id) {
    const auth = await accessTokenFor(host.id);
    if (auth) {
      try {
        await graph.cancelEvent(auth.token, b.graph_event_id, reason || 'Mötet är avbokat.');
        calendarCancelled = true;
      } catch (err) {
        await audit('system', 'graph_cancel_failed', { bookingId: b.id, error: String(err.message) });
      }
    }
  }

  const eventType = {
    title: b.title,
    description: b.description,
    location_type: b.location_type,
    location_text: b.location_text,
  };
  await mail.sendCancellationMails({
    booking: { ...b, ics_sequence: (b.ics_sequence || 0) + 1 },
    host,
    eventType,
    reason,
    cancelledBy: by,
    withIcs: !calendarCancelled,
  });
  await audit(by === 'host' ? host.email : b.invitee_email, 'booking_cancelled', {
    bookingId: b.id,
    calendarCancelled,
  });
}

async function startSession(res, user) {
  const token = randomToken(32);
  await q("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + ($3 || ' days')::interval)", [
    token,
    user.id,
    String(SESSION_DAYS),
  ]);
  res.setHeader(
    'set-cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
  );
  return token;
}

/** Kortnamn ur e-postadressen, med suffix om det redan är taget. */
async function uniqueSlug(email) {
  const bas =
    String(email).split('@')[0].toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      .slice(0, 40) || 'vard';
  for (let n = 1; n < 50; n++) {
    const kandidat = n === 1 ? bas : `${bas}-${n}`;
    const { rowCount } = await q('SELECT 1 FROM users WHERE slug = $1', [kandidat]);
    if (!rowCount) return kandidat;
  }
  return `${bas}-${randomToken(4)}`;
}

/* ---------- inloggning ---------- */

router.post('/api/login', async (req, res) => {
  const email = str(req.body?.email, 254).toLowerCase();
  const password = String(req.body?.password || '');
  if (!rateLimit(`login:${req.ip}`, 10, 15 * 60_000)) return bad(res, 429, 'För många försök. Vänta en stund.');

  const { rows } = await q('SELECT * FROM users WHERE lower(email) = $1 AND active', [email]);
  const user = rows[0];
  if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
    await audit(email, 'login_failed', { ip: req.ip });
    return bad(res, 401, 'Fel e-postadress eller lösenord');
  }
  await startSession(res, user);
  await audit(user.email, 'login_ok', { via: 'losenord' });
  res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email, slug: user.slug } });
});

router.post('/api/logout', async (req, res) => {
  const token = cookies(req)[SESSION_COOKIE];
  if (token) await q('DELETE FROM sessions WHERE token = $1', [token]);
  res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

router.get('/api/me', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return bad(res, 401, 'Inte inloggad');
  const { rows } = await q('SELECT ms_upn, expires_at, last_error, connected_at FROM ms_accounts WHERE user_id = $1', [user.id]);

  // Senaste misslyckade koppling på grund av saknad brevlåda, för att kunna
  // säga vilket konto som användes i stället för bara "det gick inte".
  const { rows: utan } = await q(
    `SELECT actor, at FROM audit_log
     WHERE action = 'ms_utan_brevlada' AND (detail->>'userId')::int = $1
       AND at > now() - interval '2 hours'
     ORDER BY id DESC LIMIT 1`,
    [user.id]
  );
  res.json({
    // id behövs för att gränssnittet ska kunna skilja ut den egna användaren:
    // utan det visas man själv i listan över kollegor att lägga till.
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      slug: user.slug,
      role: user.role,
      timezone: user.timezone,
    },
    publicUrl: `${PUBLIC_URL}/${user.slug}`,
    m365: {
      configured: graph.isConfigured(),
      connected: Boolean(rows[0]?.ms_upn),
      upn: rows[0]?.ms_upn || null,
      lastError: rows[0]?.last_error || null,
      utanBrevlada: utan[0] ? { konto: utan[0].actor, nar: utan[0].at } : null,
    },
    today: DateTime.now().setZone(TZ).setLocale('sv').toFormat('cccc d LLLL yyyy'),
  });
});

/* ---------- glömt lösenord ---------- */

const LOSENORD_MINSTA = 12;

/**
 * Begär en återställningslänk. Svaret är alltid detsamma oavsett om adressen
 * finns eller inte: annars blir formuläret ett sätt att lista ut vilka konton
 * som existerar. Vad som faktiskt hände står i granskningsloggen.
 */
router.post('/api/losenord/begar', async (req, res) => {
  const email = str(req.body?.email, 254).toLowerCase();
  const svar = {
    ok: true,
    besked: 'Finns ett konto med den adressen är en återställningslänk på väg. Kontrollera även skräpposten.',
  };

  if (!rateLimit(`atersRequest:${req.ip}`, 5, 15 * 60_000)) {
    return bad(res, 429, 'För många försök. Vänta en stund och försök igen.');
  }
  if (!isEmail(email)) return res.json(svar);

  const { rows } = await q('SELECT * FROM users WHERE lower(email) = $1 AND active', [email]);
  const user = rows[0];
  if (!user) {
    await audit(email, 'losenord_begart_okand_adress', { ip: req.ip });
    return res.json(svar);
  }

  // Tidigare obrukade länkar slutar gälla när en ny begärs.
  await q('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [user.id]);

  const token = randomToken(32);
  await q(
    `INSERT INTO password_resets (token_hash, user_id, expires_at, created_ip)
     VALUES ($1, $2, now() + interval '60 minutes', $3)`,
    [hashToken(token), user.id, req.ip]
  );

  const resultat = await mail.sendPasswordReset({
    user,
    url: `${PUBLIC_URL}/nytt-losenord/${token}`,
    giltigMinuter: 60,
  });
  await audit(user.email, 'losenord_begart', { mailAccepted: resultat.sent, ip: req.ip });
  res.json(svar);
});

/** Kontrollerar en länk innan formuläret visas, utan att röra något. */
router.get('/api/losenord/:token', async (req, res) => {
  const { rows } = await q(
    `SELECT u.name, u.email FROM password_resets r JOIN users u ON u.id = r.user_id
     WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now() AND u.active`,
    [hashToken(str(req.params.token, 200))]
  );
  if (!rows[0]) return bad(res, 404, 'Länken är använd eller har gått ut. Begär en ny.');
  res.json({ ok: true, name: rows[0].name, minstaLangd: LOSENORD_MINSTA });
});

router.post('/api/losenord/:token', async (req, res) => {
  if (!rateLimit(`atersSet:${req.ip}`, 10, 15 * 60_000)) return bad(res, 429, 'För många försök.');

  const nytt = String(req.body?.password || '');
  if (nytt.length < LOSENORD_MINSTA) {
    return bad(res, 400, `Lösenordet måste vara minst ${LOSENORD_MINSTA} tecken.`);
  }

  // Token förbrukas i samma sats som den läses, så en länk inte kan användas
  // två gånger av två samtidiga anrop.
  const { rows } = await q(
    `UPDATE password_resets SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [hashToken(str(req.params.token, 200))]
  );
  if (!rows[0]) return bad(res, 404, 'Länken är använd eller har gått ut. Begär en ny.');

  const { rows: anv } = await q(
    'UPDATE users SET password_hash = $2 WHERE id = $1 AND active RETURNING email',
    [rows[0].user_id, hashPassword(nytt)]
  );
  if (!anv[0]) return bad(res, 404, 'Kontot är avstängt.');

  // Alla sessioner sägs upp: har någon annan kommit åt kontot ska den kastas ut.
  await q('DELETE FROM sessions WHERE user_id = $1', [rows[0].user_id]);
  await audit(anv[0].email, 'losenord_aterstallt', { ip: req.ip });
  res.json({ ok: true });
});

/* ---------- M365-koppling ---------- */

router.get('/auth/ms/start', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect(`${PUBLIC_URL}/admin`);
  if (!graph.isConfigured()) return bad(res, 503, 'M365 är inte konfigurerad. Se docs/M365-KOPPLING.md');

  const { verifier, challenge } = pkce();
  const state = randomToken(16);
  await q(
    `INSERT INTO oauth_states (state, user_id, verifier, purpose, expires_at)
     VALUES ($1, $2, $3, 'connect', now() + interval '15 minutes')`,
    [state, user.id, verifier]
  );
  res.redirect(graph.authorizeUrl({ state, challenge, loginHint: user.email }));
});

/**
 * Inloggning med Microsoft. Samma samtycke ger både konto och kalenderkoppling,
 * så en ny värd är klar efter ett klick. Konto skapas bara för adresser i en
 * tillåten domän; övriga får nej och en rad i granskningsloggen.
 */
router.get('/auth/ms/login', async (req, res) => {
  if (!graph.isConfigured()) return bad(res, 503, 'Inloggning med Microsoft är inte konfigurerad');
  if (!rateLimit(`mslogin:${req.ip}`, 20, 15 * 60_000)) return bad(res, 429, 'För många försök');

  const { verifier, challenge } = pkce();
  const state = randomToken(16);
  await q(
    `INSERT INTO oauth_states (state, user_id, verifier, purpose, expires_at)
     VALUES ($1, NULL, $2, 'login', now() + interval '15 minutes')`,
    [state, verifier]
  );
  res.redirect(graph.authorizeUrl({ state, challenge }));
});

router.get('/auth/ms/callback', async (req, res) => {
  const state = str(req.query.state, 100);
  const code = str(req.query.code, 4000);
  const { rows } = await q('DELETE FROM oauth_states WHERE state = $1 AND expires_at > now() RETURNING *', [state]);
  const st = rows[0];
  if (!st) return res.redirect(`${PUBLIC_URL}/admin?ms=state`);
  if (req.query.error) return res.redirect(`${PUBLIC_URL}/admin?ms=nekad`);

  try {
    const data = await graph.exchangeCode({ code, verifier: st.verifier });
    const profile = await graph.me(data.access_token);
    const upn = profile.userPrincipalName || profile.mail;
    const epost = (profile.mail || profile.userPrincipalName || '').toLowerCase();

    // Ett konto kan godkänna behörigheten utan att ha någon brevlåda — typiskt
    // ett administratörskonto utan Exchange-licens. Då är kopplingen värdelös,
    // och felet skulle annars visa sig först när någon bokar. Spara inget.
    const kalender = await graph.calendarUsable(data.access_token);
    if (!kalender.ok) {
      await audit(upn || 'okänd', 'ms_utan_brevlada', {
        userId: st.user_id,
        purpose: st.purpose,
        error: String(kalender.error).slice(0, 300),
      });
      // Adressen skickas inte som query-parameter: den hamnar då i nginx
      // åtkomstlogg. Den hämtas i stället via /api/me av den inloggade.
      return res.redirect(`${PUBLIC_URL}/admin?ms=ingen-brevlada`);
    }

    let userId = st.user_id;
    let nyttKonto = false;

    if (st.purpose === 'login') {
      if (!epost) return res.redirect(`${PUBLIC_URL}/admin?ms=ingen-adress`);
      if (!domainAllowed(epost)) {
        await audit(epost, 'ms_login_nekad_doman', { tillatna: ALLOWED_DOMAINS });
        return res.redirect(`${PUBLIC_URL}/admin?ms=doman`);
      }

      const befintlig = await q('SELECT id, active FROM users WHERE lower(email) = $1', [epost]);
      if (befintlig.rowCount) {
        if (!befintlig.rows[0].active) {
          await audit(epost, 'ms_login_nekad_inaktiv', {});
          return res.redirect(`${PUBLIC_URL}/admin?ms=inaktiv`);
        }
        userId = befintlig.rows[0].id;
      } else {
        // Nytt konto: värd utan lösenord, med veckoschema att utgå från.
        const slug = await uniqueSlug(epost);
        const skapad = await q(
          `INSERT INTO users (slug, name, email, role, password_hash, created_via)
           VALUES ($1, $2, $3, 'host', NULL, 'microsoft') RETURNING id`,
          [slug, profile.displayName || epost, epost]
        );
        userId = skapad.rows[0].id;
        for (const weekday of [1, 2, 3, 4, 5]) {
          await q('INSERT INTO availability_rules (user_id, weekday, start_min, end_min) VALUES ($1,$2,$3,$4)', [
            userId,
            weekday,
            9 * 60,
            16 * 60,
          ]);
        }
        nyttKonto = true;
        await audit(epost, 'user_created', { userId, slug, via: 'microsoft' });
      }
    }

    if (!userId) return res.redirect(`${PUBLIC_URL}/admin?ms=fel`);

    await q(
      `INSERT INTO ms_accounts (user_id, ms_upn, ms_oid, access_token, refresh_token, expires_at, scopes, last_error)
       VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval, $7, NULL)
       ON CONFLICT (user_id) DO UPDATE SET ms_upn = $2, ms_oid = $3, access_token = $4,
         refresh_token = $5, expires_at = now() + ($6 || ' seconds')::interval, scopes = $7,
         last_error = NULL, updated_at = now()`,
      [
        userId,
        upn,
        profile.id,
        encrypt(data.access_token),
        encrypt(data.refresh_token),
        String(data.expires_in || 3600),
        data.scope || graph.SCOPES.join(' '),
      ]
    );
    await audit(upn || 'okänd', 'ms_connected', { userId, via: st.purpose });

    if (st.purpose === 'login') {
      const { rows: anv } = await q('SELECT * FROM users WHERE id = $1', [userId]);
      await startSession(res, anv[0]);
      await audit(anv[0].email, 'login_ok', { via: 'microsoft' });
      return res.redirect(`${PUBLIC_URL}/admin?ms=${nyttKonto ? 'valkommen' : 'klar'}`);
    }
    res.redirect(`${PUBLIC_URL}/admin?ms=klar`);
  } catch (err) {
    await audit('system', 'ms_callback_failed', { purpose: st.purpose, userId: st.user_id, error: String(err.message) });
    res.redirect(`${PUBLIC_URL}/admin?ms=fel`);
  }
});

router.post('/api/admin/ms/disconnect', requireAuth, async (req, res) => {
  await q('DELETE FROM ms_accounts WHERE user_id = $1', [req.user.id]);
  await audit(req.user.email, 'ms_disconnected', {});
  res.json({ ok: true });
});

/* ---------- admin: mötestyper ---------- */

router.get('/api/admin/event-types', requireAuth, async (req, res) => {
  const { rows } = await q(
    `SELECT e.*, COALESCE(
       (SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name)
        FROM event_type_hosts h JOIN users u ON u.id = h.user_id
        WHERE h.event_type_id = e.id AND u.active), '[]') AS medvardar
     FROM event_types e WHERE e.user_id = $1 ORDER BY e.title`,
    [req.user.id]
  );
  res.json({ eventTypes: rows });
});

function eventTypeFromBody(body) {
  const slug = str(body?.slug, 60).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const title = str(body?.title, 120);
  if (!slug) return { error: 'Ange en webbadress (slug)' };
  if (!title) return { error: 'Ange en rubrik' };
  const duration = int(body?.duration_min);
  if (!duration || duration < 5 || duration > 480) return { error: 'Längden måste vara 5–480 minuter' };
  const locationType = ['teams', 'phone', 'physical', 'other'].includes(body?.location_type) ? body.location_type : 'teams';
  const questions = Array.isArray(body?.questions)
    ? body.questions
        .map((x) => ({ key: str(x?.key, 160), type: x?.type === 'textarea' ? 'textarea' : 'text', required: Boolean(x?.required) }))
        .filter((x) => x.key)
        .slice(0, 10)
    : [];
  return {
    values: {
      slug,
      title,
      description: str(body?.description, 2000),
      duration_min: duration,
      buffer_before: Math.min(Math.max(int(body?.buffer_before) || 0, 0), 240),
      buffer_after: Math.min(Math.max(int(body?.buffer_after) || 0, 0), 240),
      slot_step_min: Math.min(Math.max(int(body?.slot_step_min) || 30, 5), 240),
      min_notice_min: Math.min(Math.max(int(body?.min_notice_min) ?? 240, 0), 20160),
      max_days_ahead: Math.min(Math.max(int(body?.max_days_ahead) || 60, 1), 365),
      max_per_day: int(body?.max_per_day) || null,
      location_type: locationType,
      location_text: str(body?.location_text, 300) || null,
      questions: JSON.stringify(questions),
      active: body?.active === false ? false : true,
    },
    hosts: Array.isArray(body?.hosts) ? body.hosts.map((x) => Number(x)).filter(Number.isInteger).slice(0, 20) : null,
  };
}

/** Ersätter medvärdarna på en bokningstjänst. Ägaren lagras aldrig som medvärd. */
async function sparaHosts(eventTypeId, ownerId, hosts) {
  if (!hosts) return;
  await q('DELETE FROM event_type_hosts WHERE event_type_id = $1', [eventTypeId]);
  for (const userId of hosts) {
    if (userId === ownerId) continue;
    await q(
      `INSERT INTO event_type_hosts (event_type_id, user_id)
       SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM users WHERE id = $2 AND active)
       ON CONFLICT DO NOTHING`,
      [eventTypeId, userId]
    );
  }
}

router.post('/api/admin/event-types', requireAuth, async (req, res) => {
  const parsed = eventTypeFromBody(req.body);
  if (parsed.error) return bad(res, 400, parsed.error);
  const v = parsed.values;
  try {
    const { rows } = await q(
      `INSERT INTO event_types (user_id, slug, title, description, duration_min, buffer_before,
         buffer_after, slot_step_min, min_notice_min, max_days_ahead, max_per_day, location_type,
         location_text, questions, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [req.user.id, v.slug, v.title, v.description, v.duration_min, v.buffer_before, v.buffer_after,
       v.slot_step_min, v.min_notice_min, v.max_days_ahead, v.max_per_day, v.location_type,
       v.location_text, v.questions, v.active]
    );
    await sparaHosts(rows[0].id, req.user.id, parsed.hosts);
    await audit(req.user.email, 'event_type_created', { slug: v.slug, medvardar: (parsed.hosts || []).length });
    res.status(201).json({ eventType: rows[0] });
  } catch (err) {
    if (err.code === '23505') return bad(res, 409, 'Det finns redan en mötestyp med den webbadressen');
    throw err;
  }
});

router.put('/api/admin/event-types/:id', requireAuth, async (req, res) => {
  const parsed = eventTypeFromBody(req.body);
  if (parsed.error) return bad(res, 400, parsed.error);
  const v = parsed.values;
  const { rows } = await q(
    `UPDATE event_types SET slug=$3, title=$4, description=$5, duration_min=$6, buffer_before=$7,
       buffer_after=$8, slot_step_min=$9, min_notice_min=$10, max_days_ahead=$11, max_per_day=$12,
       location_type=$13, location_text=$14, questions=$15, active=$16
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [int(req.params.id), req.user.id, v.slug, v.title, v.description, v.duration_min, v.buffer_before,
     v.buffer_after, v.slot_step_min, v.min_notice_min, v.max_days_ahead, v.max_per_day,
     v.location_type, v.location_text, v.questions, v.active]
  );
  if (!rows[0]) return bad(res, 404, 'Mötestypen finns inte');
  await sparaHosts(rows[0].id, req.user.id, parsed.hosts);
  await audit(req.user.email, 'event_type_updated', { id: rows[0].id, medvardar: (parsed.hosts || []).length });
  res.json({ eventType: rows[0] });
});

router.delete('/api/admin/event-types/:id', requireAuth, async (req, res) => {
  // Bokningar pekar på mötestypen, så den avaktiveras i stället för att raderas.
  const { rows } = await q('UPDATE event_types SET active = FALSE WHERE id = $1 AND user_id = $2 RETURNING id', [
    int(req.params.id),
    req.user.id,
  ]);
  if (!rows[0]) return bad(res, 404, 'Mötestypen finns inte');
  await audit(req.user.email, 'event_type_deactivated', { id: rows[0].id });
  res.json({ ok: true });
});

/* ---------- admin: veckoschema och undantag ---------- */

router.get('/api/admin/availability', requireAuth, async (req, res) => {
  const { rules, overrides } = await loadSchedule(req.user);
  res.json({ rules, overrides });
});

router.put('/api/admin/availability', requireAuth, async (req, res) => {
  const incoming = Array.isArray(req.body?.rules) ? req.body.rules : null;
  if (!incoming) return bad(res, 400, 'rules måste vara en lista');
  const clean = [];
  for (const r of incoming.slice(0, 50)) {
    const weekday = int(r?.weekday);
    const startMin = int(r?.start_min);
    const endMin = int(r?.end_min);
    if (!weekday || weekday < 1 || weekday > 7) return bad(res, 400, 'Ogiltig veckodag');
    if (startMin == null || endMin == null || startMin < 0 || endMin > 1440 || endMin <= startMin) {
      return bad(res, 400, 'Sluttiden måste vara efter starttiden');
    }
    clean.push({ weekday, startMin, endMin });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM availability_rules WHERE user_id = $1', [req.user.id]);
    for (const r of clean) {
      await client.query('INSERT INTO availability_rules (user_id, weekday, start_min, end_min) VALUES ($1,$2,$3,$4)', [
        req.user.id,
        r.weekday,
        r.startMin,
        r.endMin,
      ]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await audit(req.user.email, 'availability_updated', { count: clean.length });
  res.json({ ok: true, rules: clean.length });
});

router.post('/api/admin/overrides', requireAuth, async (req, res) => {
  const date = str(req.body?.on_date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad(res, 400, 'Ange datum som ÅÅÅÅ-MM-DD');
  const unavailable = req.body?.unavailable !== false;
  const startMin = unavailable ? null : int(req.body?.start_min);
  const endMin = unavailable ? null : int(req.body?.end_min);
  if (!unavailable && (startMin == null || endMin == null || endMin <= startMin)) {
    return bad(res, 400, 'Ange giltiga tider för dagen');
  }
  await q(
    `INSERT INTO date_overrides (user_id, on_date, unavailable, start_min, end_min, note)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, on_date) DO UPDATE SET unavailable=$3, start_min=$4, end_min=$5, note=$6`,
    [req.user.id, date, unavailable, startMin, endMin, str(req.body?.note, 200) || null]
  );
  await audit(req.user.email, 'override_saved', { date, unavailable });
  res.json({ ok: true });
});

router.delete('/api/admin/overrides/:date', requireAuth, async (req, res) => {
  await q('DELETE FROM date_overrides WHERE user_id = $1 AND on_date = $2', [req.user.id, str(req.params.date, 10)]);
  res.json({ ok: true });
});

/* ---------- admin: bokningar ---------- */

router.get('/api/admin/bookings', requireAuth, async (req, res) => {
  const scope = req.query.scope === 'past' ? 'past' : 'upcoming';
  const { rows } = await q(
    `SELECT b.id, b.start_utc, b.end_utc, b.invitee_name, b.invitee_email, b.invitee_org,
            b.answers, b.status, b.join_url, b.cancel_reason, b.cancelled_by, e.title
     FROM bookings b JOIN event_types e ON e.id = b.event_type_id
     WHERE b.user_id = $1 AND ${scope === 'past' ? 'b.start_utc < now()' : 'b.start_utc >= now()'}
     ORDER BY b.start_utc ${scope === 'past' ? 'DESC' : 'ASC'} LIMIT 200`,
    [req.user.id]
  );
  res.json({
    bookings: rows.map((b) => ({
      ...b,
      when: formatSwedish(new Date(b.start_utc).toISOString(), new Date(b.end_utc).toISOString(), req.user.timezone || TZ),
    })),
  });
});

router.post('/api/admin/bookings/:id/cancel', requireAuth, async (req, res) => {
  const { rows } = await q(
    `SELECT b.*, e.title, e.description, e.location_type, e.location_text,
            u.id AS host_id, u.name AS host_name, u.email AS host_email, u.title AS host_title
     FROM bookings b JOIN event_types e ON e.id = b.event_type_id JOIN users u ON u.id = b.user_id
     WHERE b.id = $1 AND b.user_id = $2`,
    [int(req.params.id), req.user.id]
  );
  const b = rows[0];
  if (!b) return bad(res, 404, 'Bokningen finns inte');
  if (b.status === 'cancelled') return res.json({ ok: true, alreadyCancelled: true });
  await cancelBooking(b, { by: 'host', reason: str(req.body?.reason, 500) });
  res.json({ ok: true });
});

router.get('/api/admin/gallring', requireAuth, async (req, res) => {
  const { rows } = await q(
    "SELECT at, detail FROM audit_log WHERE action = 'gallring' ORDER BY id DESC LIMIT 1"
  );
  res.json({
    installningar: gallringInst(),
    senaste: rows[0] ? { at: rows[0].at, ...rows[0].detail } : null,
    // Torrkörning: visar vad som skulle tas bort just nu, utan att röra något.
    nu: await gallra({ torrkörning: true }),
  });
});

router.post('/api/admin/gallring', requireAuth, async (req, res) => {
  const resultat = await gallra();
  await audit(req.user.email, 'gallring_manuell', resultat);
  res.json({ ok: true, ...resultat });
});

router.put('/api/admin/password', requireAuth, async (req, res) => {
  const current = String(req.body?.current || '');
  const next = String(req.body?.next || '');
  if (next.length < LOSENORD_MINSTA) {
    return bad(res, 400, `Nytt lösenord måste vara minst ${LOSENORD_MINSTA} tecken`);
  }
  const { rows } = await q('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (rows[0]?.password_hash && !verifyPassword(current, rows[0].password_hash)) {
    return bad(res, 401, 'Fel nuvarande lösenord');
  }
  await q('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, hashPassword(next)]);
  await q('DELETE FROM sessions WHERE user_id = $1', [req.user.id]);
  await audit(req.user.email, 'password_changed', {});
  res.json({ ok: true });
});

/* ---------- superadmin och organisation ---------- */

const { requireAdmin } = require('./lib/admin-routes')({
  router,
  requireAuth,
  helpers: { bad, str, int, isEmail },
});

// Loggan serveras från projektets media-katalog.
// Loggan får cachas: filnamnet byts vid varje uppladdning.
router.use('/media', express.static(path.join(__dirname, 'media'), { maxAge: '1h', etag: true }));

/* ---------- omröstningar ---------- */

require('./lib/poll-routes')({
  router,
  requireAuth,
  helpers: { bad, str, int, isEmail, rateLimit, accessTokenFor, busyFor, loadSchedule, PUBLIC_URL },
});

/* ---------- sidor ---------- */

const page = (name) => (req, res) => res.sendFile(path.join(__dirname, 'public', name));

/**
 * Avslutande snedstreck tas bort. Sidorna hämtar css och js med relativa
 * sökvägar, och /boka/thomas/ pekar ut en annan katalog än /boka/thomas —
 * då hämtas stilmallen från fel plats. Hellre en omdirigering än en trasig sida.
 */
router.use((req, res, next) => {
  if (req.method === 'GET' && req.path !== '/' && req.path.endsWith('/')) {
    let mal = req.originalUrl.replace(/\/+(\?|$)/, '$1');
    if (mal === req.originalUrl) return next();
    // Nginx strippar /boka innan appen ser sökvägen, men skickar med prefixet
    // som header. Utan detta pekar omdirigeringen på fel plats.
    const prefix = str(req.get('x-forwarded-prefix') || '', 100).replace(/\/+$/, '');
    if (prefix && !mal.startsWith(prefix + '/') && mal !== prefix) mal = prefix + mal;
    return res.redirect(301, mal);
  }
  next();
});

/*
 * Ingen cachningstid på sidor och skript. Filerna är bind-montade och ändras i
 * drift, och en webbläsare som kört gammal JavaScript mot ny HTML gav ett fel som
 * såg ut som en trasig sida: loggan försvann helt. ETag gör att en oförändrad fil
 * ändå svarar 304, så kostnaden är en förfrågan, inte en nedladdning.
 */
router.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    maxAge: 0,
    etag: true,
    lastModified: true,
  })
);
router.get('/', page('index.html'));
router.get('/admin', page('admin.html'));
router.get('/avboka/:token', page('avboka.html'));
router.get('/omrostning/:token', page('omrostning.html'));
router.get('/nytt-losenord/:token', page('nytt-losenord.html'));
router.get('/:hostSlug', page('vard.html'));
router.get('/:hostSlug/:eventSlug', page('boka.html'));

// Bakom nginx kan sökvägen komma både med och utan /boka, beroende på hur
// proxyn är satt. Routern monteras på båda så routingen inte blir känslig.
if (BASE_PATH) app.use(BASE_PATH, router);
app.use('/', router);

app.use((req, res) => res.status(404).json({ error: 'Sidan finns inte' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  // För stor kropp fångas av body-parsern innan någon rutt körs. Utan det här
  // svarar tjänsten 500 på en uppladdning som bara var för stor.
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'Filen är för stor. Högst 1500 kB för en logotyp.' });
  }
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
    return res.status(400).json({ error: 'Kunde inte tolka anropet' });
  }

  console.error('Fel:', err && err.stack ? err.stack : err);
  res.status(500).json({ error: 'Något gick fel' });
});

/* ---------- start ---------- */

(async () => {
  await waitForDatabase();
  await applySchema();
  await seed();
  startaGallring();

  // Städa bort utgångna sessioner och oauth-tillstånd en gång i timmen.
  setInterval(() => {
    q('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
    q('DELETE FROM oauth_states WHERE expires_at < now()').catch(() => {});
    q("DELETE FROM password_resets WHERE expires_at < now() - interval '7 days'").catch(() => {});
  }, 3600_000).unref();

  app.listen(PORT, () => {
    console.log(`Boka tid lyssnar på ${PORT}, bas "${BASE_PATH || '/'}", publik adress ${PUBLIC_URL}`);
    console.log(`M365: ${graph.isConfigured() ? 'konfigurerad' : 'ej konfigurerad — kalenderskrivning av'}`);
  });
})().catch((err) => {
  console.error('Kunde inte starta:', err);
  process.exit(1);
});
