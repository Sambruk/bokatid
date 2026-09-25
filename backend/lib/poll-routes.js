'use strict';
// Rutterna för omröstningar: admin skapar och beslutar, deltagare svarar.
// Modulen får sina beroenden inskickade från server.js, så den inte behöver
// känna till hur sessioner eller tillgänglighet är byggda.

const { DateTime } = require('luxon');
const { q, audit } = require('./db');
const { availableSlots, isSlotAvailable, formatSwedish } = require('./slots');
const { randomToken } = require('./crypto');
const graph = require('./graph');
const mail = require('./mail');
const { loadPoll, loadPollByToken, tally, ranked } = require('./polls-sql');

const TZ = 'Europe/Stockholm';

module.exports = function pollRoutes({ router, requireAuth, helpers }) {
  const { bad, str, int, isEmail, rateLimit, accessTokenFor, busyFor, loadSchedule, PUBLIC_URL } = helpers;

  const pollUrl = (token) => `${PUBLIC_URL}/omrostning/${token}`;

  /** Pseudomötestyp för slotmotorn: en omröstning har ingen mötestyp i databasen. */
  const pollEventType = (p) => ({
    duration_min: p.duration_min,
    buffer_before: p.buffer_before ?? 0,
    buffer_after: p.buffer_after ?? 0,
    slot_step_min: p.slot_step_min ?? 30,
    min_notice_min: p.min_notice_min ?? 0,
    max_days_ahead: 365,
    max_per_day: null,
  });

  /* ---------- admin: lediga tider att föreslå ---------- */

  router.get('/api/admin/poll-slots', requireAuth, async (req, res) => {
    const duration = int(req.query.duration) || 60;
    if (duration < 5 || duration > 480) return bad(res, 400, 'Längden måste vara 5–480 minuter');
    const tz = req.user.timezone || TZ;

    let from = DateTime.fromISO(str(req.query.from, 10), { zone: tz });
    if (!from.isValid) from = DateTime.now().setZone(tz);
    let to = DateTime.fromISO(str(req.query.to, 10), { zone: tz });
    if (!to.isValid) to = from.plus({ days: 20 });
    if (to > from.plus({ days: 60 })) to = from.plus({ days: 60 });

    const eventType = pollEventType({
      duration_min: duration,
      buffer_before: int(req.query.buffer_before) || 0,
      buffer_after: int(req.query.buffer_after) || 0,
      slot_step_min: int(req.query.step) || 30,
      min_notice_min: int(req.query.min_notice) ?? 0,
    });

    const { rules, overrides } = await loadSchedule(req.user);
    const { busy, calendarChecked } = await busyFor(
      req.user,
      from.startOf('day').toUTC().toISO(),
      to.endOf('day').toUTC().toISO(),
      { ignorePollId: int(req.query.ignore_poll) || null }
    );

    const days = availableSlots({
      timezone: tz,
      rules,
      overrides,
      eventType,
      busy,
      fromDate: from.toISODate(),
      toDate: to.toISODate(),
    });

    res.json({
      calendarChecked,
      days: days
        .filter((d) => d.slots.length)
        .map((d) => ({
          date: d.date,
          label: DateTime.fromISO(d.date, { zone: tz }).setLocale('sv').toFormat('cccc d LLLL'),
          slots: d.slots.map((s) => ({
            start: s.start,
            end: s.end,
            label: DateTime.fromISO(s.start, { zone: 'utc' }).setZone(tz).toFormat('HH:mm'),
          })),
        })),
    });
  });

  /* ---------- admin: skapa ---------- */

  router.post('/api/admin/polls', requireAuth, async (req, res) => {
    const title = str(req.body?.title, 160);
    if (title.length < 2) return bad(res, 400, 'Ange en rubrik');
    const duration = int(req.body?.duration_min);
    if (!duration || duration < 5 || duration > 480) return bad(res, 400, 'Längden måste vara 5–480 minuter');

    const starts = Array.isArray(req.body?.options) ? req.body.options.slice(0, 20) : [];
    if (!starts.length) return bad(res, 400, 'Föreslå minst en tid');

    const locationType = ['teams', 'phone', 'physical', 'other'].includes(req.body?.location_type)
      ? req.body.location_type
      : 'teams';

    const deltagare = (Array.isArray(req.body?.participants) ? req.body.participants : [])
      .slice(0, 50)
      .map((p) => ({ name: str(p?.name, 120), email: str(p?.email, 254).toLowerCase(), org: str(p?.org, 160) }))
      .filter((p) => p.name && p.email);
    for (const p of deltagare) {
      if (!isEmail(p.email)) return bad(res, 400, `Ogiltig e-postadress: ${p.email}`);
    }

    let deadline = null;
    if (str(req.body?.deadline, 10)) {
      const d = DateTime.fromISO(str(req.body.deadline, 10), { zone: req.user.timezone || TZ }).endOf('day');
      if (!d.isValid) return bad(res, 400, 'Ogiltig sista svarsdag');
      deadline = d.toUTC().toISO();
    }

    // Varje föreslagen tid prövas mot veckoschemat, befintliga bokningar, andra
    // omröstningars reservationer och kalendern. Det är själva poängen: det ska
    // inte gå att föreslå en tid som redan är upptagen.
    const tz = req.user.timezone || TZ;
    const { rules, overrides } = await loadSchedule(req.user);
    const eventType = pollEventType({
      duration_min: duration,
      slot_step_min: 5,
      min_notice_min: 0,
      buffer_before: int(req.body?.buffer_before) || 0,
      buffer_after: int(req.body?.buffer_after) || 0,
    });

    const tider = [];
    for (const raw of starts) {
      const start = DateTime.fromISO(str(raw, 40), { zone: 'utc' });
      if (!start.isValid) return bad(res, 400, 'Ogiltig tid bland förslagen');
      if (start < DateTime.now()) return bad(res, 400, 'En av tiderna har redan passerat');
      tider.push(start);
    }
    tider.sort((a, b) => a - b);

    const fran = tider[0].minus({ days: 1 }).toISO();
    const till = tider[tider.length - 1].plus({ days: 1 }).toISO();
    const { busy, calendarChecked } = await busyFor(req.user, fran, till);

    for (const start of tider) {
      const ledig = isSlotAvailable(
        { timezone: tz, rules, overrides, eventType, busy },
        start.toUTC().toISO()
      );
      if (!ledig) {
        return bad(
          res,
          409,
          `Tiden ${formatSwedish(start.toUTC().toISO(), start.plus({ minutes: duration }).toUTC().toISO(), tz)} är inte ledig och kan inte föreslås.`
        );
      }
    }

    const publicToken = randomToken(18);
    const { rows: skapad } = await q(
      `INSERT INTO polls (user_id, public_token, title, description, duration_min,
         location_type, location_text, deadline, hold_calendar, hide_names)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        req.user.id,
        publicToken,
        title,
        str(req.body?.description, 2000) || null,
        duration,
        locationType,
        str(req.body?.location_text, 300) || null,
        deadline,
        req.body?.hold_calendar !== false,
        req.body?.hide_names === true,
      ]
    );
    const poll = skapad[0];

    for (const start of tider) {
      await q('INSERT INTO poll_options (poll_id, start_utc, end_utc) VALUES ($1,$2,$3)', [
        poll.id,
        start.toUTC().toISO(),
        start.plus({ minutes: duration }).toUTC().toISO(),
      ]);
    }

    const holdResultat = poll.hold_calendar ? await syncHolds(req.user, poll.id) : { skapade: 0, fel: [] };

    // Deltagare och inbjudningar.
    let utskick = 0;
    const utskicksfel = [];
    for (const p of deltagare) {
      const token = randomToken(18);
      const { rows } = await q(
        `INSERT INTO poll_participants (poll_id, name, email, org, token)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (poll_id, lower(email)) DO UPDATE SET name = EXCLUDED.name
         RETURNING *`,
        [poll.id, p.name, p.email, p.org || null, token]
      );
      const deltagareRad = rows[0];
      const optioner = (await q('SELECT * FROM poll_options WHERE poll_id = $1 ORDER BY start_utc', [poll.id])).rows;
      const svar = await mail.sendPollInvitation({
        poll,
        host: req.user,
        participant: deltagareRad,
        url: `${pollUrl(poll.public_token)}?svar=${deltagareRad.token}`,
        options: optioner,
      });
      if (svar.sent) {
        await q('UPDATE poll_participants SET invited_at = now() WHERE id = $1', [deltagareRad.id]);
        utskick++;
      } else {
        utskicksfel.push(p.email);
      }
    }

    await audit(req.user.email, 'poll_created', {
      pollId: poll.id,
      antalTider: tider.length,
      antalDeltagare: deltagare.length,
      utskick,
      preliminarbokningar: holdResultat.skapade,
      kalenderLast: calendarChecked,
    });

    res.status(201).json({
      poll: { id: poll.id, url: pollUrl(poll.public_token) },
      holds: holdResultat,
      invitations: { skickade: utskick, misslyckade: utskicksfel },
    });
  });

  /**
   * Skapar preliminärbokningar för de förslag som saknar en. Idempotent: körs om
   * utan att skapa dubbletter, och används både vid skapande och när en
   * kalenderkoppling tillkommit i efterhand.
   */
  async function syncHolds(user, pollId) {
    const poll = await loadPoll(pollId, user.id);
    if (!poll) return { skapade: 0, fel: ['Omröstningen finns inte'] };

    const auth = await accessTokenFor(user.id);
    if (!auth) return { skapade: 0, fel: ['Ingen M365-kalender är kopplad'] };

    let skapade = 0;
    const fel = [];
    for (const o of poll.options) {
      if (o.graph_event_id) continue;
      try {
        const { id } = await graph.createHold(auth.token, {
          subject: `Preliminär: ${poll.title}`,
          bodyHtml:
            `<p>Reserverad tid i väntan på svar i en omröstning om mötestid.</p>` +
            `<p>Tiden släpps automatiskt när en annan tid beslutas.</p>` +
            `<p>Omröstning: ${pollUrl(poll.public_token)}</p>`,
          startIso: new Date(o.start_utc).toISOString(),
          endIso: new Date(o.end_utc).toISOString(),
          transactionId: `poll-${poll.id}-opt-${o.id}`,
        });
        await q('UPDATE poll_options SET graph_event_id = $2, hold_error = NULL WHERE id = $1', [o.id, id]);
        skapade++;
      } catch (err) {
        await q('UPDATE poll_options SET hold_error = $2 WHERE id = $1', [o.id, String(err.message).slice(0, 300)]);
        fel.push(String(err.message));
        await audit('system', 'poll_hold_failed', { pollId: poll.id, optionId: o.id, error: String(err.message) });
      }
    }
    return { skapade, fel };
  }

  /** Tar bort preliminärbokningarna, valfritt med undantag för ett förslag. */
  async function releaseHolds(user, poll, { utom = null } = {}) {
    const auth = await accessTokenFor(user.id);
    let borttagna = 0;
    for (const o of poll.options) {
      if (!o.graph_event_id || o.id === utom) continue;
      if (auth) {
        try {
          await graph.deleteEvent(auth.token, o.graph_event_id);
          borttagna++;
        } catch (err) {
          await audit('system', 'poll_hold_release_failed', {
            pollId: poll.id,
            optionId: o.id,
            error: String(err.message),
          });
          continue;
        }
      }
      await q('UPDATE poll_options SET graph_event_id = NULL WHERE id = $1', [o.id]);
    }
    return borttagna;
  }

  /* ---------- admin: lista och visa ---------- */

  router.get('/api/admin/polls', requireAuth, async (req, res) => {
    const { rows } = await q(
      `SELECT p.id, p.title, p.status, p.deadline, p.created_at, p.duration_min, p.public_token,
              (SELECT count(*) FROM poll_options o WHERE o.poll_id = p.id) AS antal_tider,
              (SELECT count(*) FROM poll_participants d WHERE d.poll_id = p.id) AS antal_deltagare,
              (SELECT count(*) FROM poll_participants d WHERE d.poll_id = p.id AND d.responded_at IS NOT NULL) AS antal_svar
       FROM polls p WHERE p.user_id = $1 ORDER BY p.created_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json({
      polls: rows.map((p) => ({
        ...p,
        url: pollUrl(p.public_token),
        public_token: undefined,
      })),
    });
  });

  router.get('/api/admin/polls/:id', requireAuth, async (req, res) => {
    const poll = await loadPoll(int(req.params.id), req.user.id);
    if (!poll) return bad(res, 404, 'Omröstningen finns inte');
    const tz = poll.timezone || TZ;
    const rakning = tally(poll);

    const svarPerDeltagare = new Map();
    for (const v of poll.votes) {
      if (!svarPerDeltagare.has(v.participant_id)) svarPerDeltagare.set(v.participant_id, {});
      svarPerDeltagare.get(v.participant_id)[v.option_id] = v.answer;
    }

    res.json({
      poll: {
        id: poll.id,
        title: poll.title,
        description: poll.description,
        duration_min: poll.duration_min,
        location_type: poll.location_type,
        location_text: poll.location_text,
        status: poll.status,
        deadline: poll.deadline,
        hold_calendar: poll.hold_calendar,
        hide_names: poll.hide_names,
        decided_option: poll.decided_option,
        decided_join: poll.decided_join,
        url: pollUrl(poll.public_token),
      },
      options: ranked(poll).map((o) => ({
        id: o.id,
        start: o.start_utc,
        when: formatSwedish(new Date(o.start_utc).toISOString(), new Date(o.end_utc).toISOString(), tz),
        holdOk: Boolean(o.graph_event_id),
        holdError: o.hold_error,
        rakning: o.rakning,
      })),
      participants: poll.participants.map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        org: p.org,
        invited: Boolean(p.invited_at),
        responded: Boolean(p.responded_at),
        svar: svarPerDeltagare.get(p.id) || {},
        url: `${pollUrl(poll.public_token)}?svar=${p.token}`,
      })),
    });
  });

  /* ---------- admin: lägg till deltagare, påminn ---------- */

  router.post('/api/admin/polls/:id/participants', requireAuth, async (req, res) => {
    const poll = await loadPoll(int(req.params.id), req.user.id);
    if (!poll) return bad(res, 404, 'Omröstningen finns inte');
    if (poll.status !== 'open') return bad(res, 409, 'Omröstningen är inte öppen');

    const name = str(req.body?.name, 120);
    const email = str(req.body?.email, 254).toLowerCase();
    if (!name) return bad(res, 400, 'Ange namn');
    if (!isEmail(email)) return bad(res, 400, 'Ange en giltig e-postadress');

    const { rows } = await q(
      `INSERT INTO poll_participants (poll_id, name, email, org, token)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (poll_id, lower(email)) DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [poll.id, name, email, str(req.body?.org, 160) || null, randomToken(18)]
    );
    const deltagare = rows[0];

    const svar = await mail.sendPollInvitation({
      poll,
      host: req.user,
      participant: deltagare,
      url: `${pollUrl(poll.public_token)}?svar=${deltagare.token}`,
      options: poll.options,
    });
    if (svar.sent) await q('UPDATE poll_participants SET invited_at = now() WHERE id = $1', [deltagare.id]);

    await audit(req.user.email, 'poll_participant_added', { pollId: poll.id, skickat: svar.sent });
    res.status(201).json({ ok: true, mailAccepted: svar.sent });
  });

  router.post('/api/admin/polls/:id/remind', requireAuth, async (req, res) => {
    const poll = await loadPoll(int(req.params.id), req.user.id);
    if (!poll) return bad(res, 404, 'Omröstningen finns inte');
    if (poll.status !== 'open') return bad(res, 409, 'Omröstningen är inte öppen');

    const utan = poll.participants.filter((p) => !p.responded_at);
    let skickade = 0;
    for (const p of utan) {
      const svar = await mail.sendPollInvitation({
        poll,
        host: req.user,
        participant: p,
        url: `${pollUrl(poll.public_token)}?svar=${p.token}`,
        options: poll.options,
      });
      if (svar.sent) skickade++;
    }
    await audit(req.user.email, 'poll_reminded', { pollId: poll.id, skickade, utan: utan.length });
    res.json({ ok: true, skickade, utanSvar: utan.length });
  });

  /* ---------- admin: stäng, besluta, avbryt ---------- */

  router.post('/api/admin/polls/:id/close', requireAuth, async (req, res) => {
    const poll = await loadPoll(int(req.params.id), req.user.id);
    if (!poll) return bad(res, 404, 'Omröstningen finns inte');
    if (poll.status !== 'open') return bad(res, 409, 'Omröstningen är redan stängd');
    await q("UPDATE polls SET status = 'closed', closed_at = now() WHERE id = $1", [poll.id]);
    await audit(req.user.email, 'poll_closed', { pollId: poll.id });
    res.json({ ok: true });
  });

  router.post('/api/admin/polls/:id/reopen', requireAuth, async (req, res) => {
    const poll = await loadPoll(int(req.params.id), req.user.id);
    if (!poll) return bad(res, 404, 'Omröstningen finns inte');
    if (poll.status !== 'closed') return bad(res, 409, 'Bara en stängd omröstning kan öppnas igen');
    await q("UPDATE polls SET status = 'open', closed_at = NULL WHERE id = $1", [poll.id]);
    const holds = poll.hold_calendar ? await syncHolds(req.user, poll.id) : { skapade: 0 };
    await audit(req.user.email, 'poll_reopened', { pollId: poll.id, holds: holds.skapade });
    res.json({ ok: true });
  });

  router.post('/api/admin/polls/:id/decide', requireAuth, async (req, res) => {
    const poll = await loadPoll(int(req.params.id), req.user.id);
    if (!poll) return bad(res, 404, 'Omröstningen finns inte');
    if (poll.status === 'decided') return bad(res, 409, 'Tiden är redan beslutad');
    if (poll.status === 'cancelled') return bad(res, 409, 'Omröstningen är avbruten');

    const option = poll.options.find((o) => o.id === int(req.body?.optionId));
    if (!option) return bad(res, 400, 'Välj en av de föreslagna tiderna');

    // Vilka som ska med på mötet. Standard är alla inbjudna: de bjöds in till
    // mötet, inte bara till omröstningen. Utfärdaren kan välja att bara ta med
    // dem som svarat.
    const svarande = poll.participants.filter((p) => p.responded_at);
    const baraSvarande = req.body?.invite === 'svarande';
    const deltagare = baraSvarande && svarande.length ? svarande : poll.participants;
    const ovriga = poll.participants.filter((p) => !deltagare.some((d) => d.id === p.id));

    let calendarWritten = false;
    let joinUrl = null;
    let eventId = null;
    const auth = await accessTokenFor(req.user.id);

    if (auth) {
      try {
        // Preliminärbokningen för den valda tiden tas bort först, så att det
        // riktiga mötet inte ligger dubbelt i kalendern.
        if (option.graph_event_id) {
          await graph.deleteEvent(auth.token, option.graph_event_id);
          await q('UPDATE poll_options SET graph_event_id = NULL WHERE id = $1', [option.id]);
        }
        const created = await graph.call(auth.token, '/me/events', {
          method: 'POST',
          body: {
            subject: poll.title,
            body: {
              contentType: 'HTML',
              content:
                `<p>Tid beslutad efter omröstning.</p>` +
                (poll.description ? `<p>${poll.description}</p>` : ''),
            },
            start: { dateTime: new Date(option.start_utc).toISOString().replace('Z', ''), timeZone: 'UTC' },
            end: { dateTime: new Date(option.end_utc).toISOString().replace('Z', ''), timeZone: 'UTC' },
            attendees: deltagare.map((p) => ({
              emailAddress: { address: p.email, name: p.name },
              type: 'required',
            })),
            allowNewTimeProposals: false,
            isOnlineMeeting: poll.location_type === 'teams',
            ...(poll.location_type === 'teams' ? { onlineMeetingProvider: 'teamsForBusiness' } : {}),
            ...(poll.location_text ? { location: { displayName: poll.location_text } } : {}),
            transactionId: `poll-${poll.id}-beslut`,
          },
        });
        eventId = created.id;
        joinUrl = created.onlineMeeting?.joinUrl || created.onlineMeetingUrl || null;
        calendarWritten = true;
      } catch (err) {
        await audit('system', 'poll_decide_calendar_failed', { pollId: poll.id, error: String(err.message) });
      }
    }

    // Övriga preliminärbokningar släpps oavsett hur det gick med mötet.
    const slappta = await releaseHolds(req.user, poll, { utom: null });

    await q(
      `UPDATE polls SET status = 'decided', decided_option = $2, decided_event = $3,
         decided_join = $4, decided_at = now() WHERE id = $1`,
      [poll.id, option.id, eventId, joinUrl]
    );

    /*
     * Ett mail per person. Skapades mötet i kalendern skickar Outlook sin egen
     * inbjudan till deltagarna, och då skickar vi inget eget — det skulle bara
     * upprepa samma uppgifter. Misslyckades kalenderskrivningen är vårt mail med
     * kalenderfil det enda beskedet som går ut.
     */
    const mailResultat = calendarWritten
      ? { sent: true, viaOutlook: true }
      : await mail.sendPollDecision({
          poll,
          host: req.user,
          option,
          participants: deltagare,
          joinUrl,
          withIcs: true,
        });

    // De som inte är med på mötet får ingen inbjudan från Outlook, så de får ett
    // kort besked om att tiden är bestämd.
    const mailOvriga = ovriga.length
      ? await mail.sendPollDecision({
          poll,
          host: req.user,
          option,
          participants: ovriga,
          joinUrl,
          withIcs: false,
          baraBesked: true,
        })
      : { sent: true };

    await audit(req.user.email, 'poll_decided', {
      pollId: poll.id,
      optionId: option.id,
      calendarWritten,
      slapptaReservationer: slappta,
      beskedViaOutlook: Boolean(mailResultat.viaOutlook),
      mailAccepted: mailResultat.sent && mailOvriga.sent,
      antalDeltagare: deltagare.length,
      antalUtanInbjudan: ovriga.length,
    });

    res.json({
      ok: true,
      calendarWritten,
      joinUrl,
      releasedHolds: slappta,
      // Sant när Outlooks egen inbjudan är beskedet och vi inte skickat något eget.
      beskedViaOutlook: Boolean(mailResultat.viaOutlook),
      antalDeltagare: deltagare.length,
      antalUtanInbjudan: ovriga.length,
      mailAccepted: mailResultat.sent && mailOvriga.sent,
      when: formatSwedish(
        new Date(option.start_utc).toISOString(),
        new Date(option.end_utc).toISOString(),
        poll.timezone || TZ
      ),
    });
  });

  router.post('/api/admin/polls/:id/cancel', requireAuth, async (req, res) => {
    const poll = await loadPoll(int(req.params.id), req.user.id);
    if (!poll) return bad(res, 404, 'Omröstningen finns inte');
    if (poll.status === 'cancelled') return res.json({ ok: true, alreadyCancelled: true });
    if (poll.status === 'decided') return bad(res, 409, 'Tiden är redan beslutad. Avboka mötet i kalendern i stället.');

    const reason = str(req.body?.reason, 500);
    const slappta = await releaseHolds(req.user, poll);
    await q("UPDATE polls SET status = 'cancelled' WHERE id = $1", [poll.id]);

    const mottagare = poll.participants.filter((p) => p.invited_at);
    const mailResultat = mottagare.length
      ? await mail.sendPollCancelled({ poll, host: req.user, participants: mottagare, reason })
      : { sent: true };

    await audit(req.user.email, 'poll_cancelled', {
      pollId: poll.id,
      slapptaReservationer: slappta,
      mailAccepted: mailResultat.sent,
    });
    res.json({ ok: true, releasedHolds: slappta, mailAccepted: mailResultat.sent });
  });

  /* ---------- admin: rensa ---------- */

  /**
   * Rensar avslutade omröstningar äldre än ett antal dagar. Omröstningarna bär
   * namn och e-postadresser till externa personer, så de ska inte ligga kvar
   * längre än de behövs. Bara beslutade och avbrutna rensas — en öppen omröstning
   * väntar fortfarande på svar, och tas bort med sitt eget anrop.
   *
   * Ligger före rutterna med :id så att "rensa" inte kan fångas som ett id om
   * någon senare lägger till en POST direkt på /api/admin/polls/:id.
   */
  router.post('/api/admin/polls/rensa', requireAuth, async (req, res) => {
    const dagar = Math.min(Math.max(int(req.body?.older_than_days) ?? 90, 0), 3650);

    const { rows } = await q(
      `SELECT id, title, status FROM polls
       WHERE user_id = $1 AND status IN ('decided','cancelled')
         AND COALESCE(decided_at, closed_at, created_at) < now() - ($2 || ' days')::interval
       ORDER BY id`,
      [req.user.id, String(dagar)]
    );
    if (!rows.length) return res.json({ ok: true, borttagna: 0 });

    // Säkerhetsnät: har någon reservation blivit kvar släpps den innan raderingen,
    // annars skulle den ligga kvar i kalendern utan något som pekar på den.
    let slappta = 0;
    for (const rad of rows) {
      const poll = await loadPoll(rad.id, req.user.id);
      if (poll) slappta += await releaseHolds(req.user, poll);
    }

    const { rowCount } = await q('DELETE FROM polls WHERE id = ANY($1::int[]) AND user_id = $2', [
      rows.map((r) => r.id),
      req.user.id,
    ]);

    await audit(req.user.email, 'polls_purged', {
      antal: rowCount,
      aldreAnDagar: dagar,
      slapptaReservationer: slappta,
    });
    res.json({ ok: true, borttagna: rowCount, slapptaReservationer: slappta });
  });

  /**
   * Tar bort en enskild omröstning med svar och deltagare. Ligger tiden kvar som
   * ett beslutat möte i kalendern rörs det inte — mötet är bokat och ska inte
   * försvinna för att underlaget städas bort.
   */
  router.delete('/api/admin/polls/:id', requireAuth, async (req, res) => {
    const poll = await loadPoll(int(req.params.id), req.user.id);
    if (!poll) return bad(res, 404, 'Omröstningen finns inte');

    // Öppna omröstningar har reservationer i kalendern som måste släppas först.
    const slappta = await releaseHolds(req.user, poll);

    const kvarIKalendern = poll.status === 'decided' && poll.decided_event;
    await q('DELETE FROM polls WHERE id = $1 AND user_id = $2', [poll.id, req.user.id]);

    await audit(req.user.email, 'poll_deleted', {
      pollId: poll.id,
      status: poll.status,
      slapptaReservationer: slappta,
      antalDeltagare: poll.participants.length,
      motetKvarIKalendern: Boolean(kvarIKalendern),
    });
    res.json({ ok: true, releasedHolds: slappta, motetKvarIKalendern: Boolean(kvarIKalendern) });
  });

  /* ---------- publikt: hämta och rösta ---------- */

  router.get('/api/poll/:token', async (req, res) => {
    const poll = await loadPollByToken(str(req.params.token, 80));
    if (!poll) return bad(res, 404, 'Omröstningen finns inte');
    const tz = poll.timezone || TZ;
    const rakning = tally(poll);

    // Personlig svarslänk: ger egna tidigare svar tillbaka, aldrig andras adresser.
    const egenToken = str(req.query.svar, 80);
    const jag = egenToken ? poll.participants.find((p) => p.token === egenToken) : null;
    const egnaSvar = {};
    if (jag) {
      for (const v of poll.votes) if (v.participant_id === jag.id) egnaSvar[v.option_id] = v.answer;
    }

    const svarPerDeltagare = new Map();
    for (const v of poll.votes) {
      if (!svarPerDeltagare.has(v.participant_id)) svarPerDeltagare.set(v.participant_id, {});
      svarPerDeltagare.get(v.participant_id)[v.option_id] = v.answer;
    }

    const beslutad = poll.decided_option ? poll.options.find((o) => o.id === poll.decided_option) : null;

    res.json({
      title: poll.title,
      description: poll.description,
      duration_min: poll.duration_min,
      status: poll.status,
      deadline: poll.deadline,
      host: { name: poll.host_name, title: poll.host_title },
      location: mail.locationLine(
        { join_url: poll.decided_join },
        { location_type: poll.location_type, location_text: poll.location_text }
      ),
      options: poll.options.map((o) => ({
        id: o.id,
        when: formatSwedish(new Date(o.start_utc).toISOString(), new Date(o.end_utc).toISOString(), tz),
        datum: DateTime.fromISO(new Date(o.start_utc).toISOString(), { zone: 'utc' })
          .setZone(tz)
          .setLocale('sv')
          .toFormat('cccc d LLLL'),
        tid: `${DateTime.fromISO(new Date(o.start_utc).toISOString(), { zone: 'utc' }).setZone(tz).toFormat('HH:mm')}–${DateTime.fromISO(new Date(o.end_utc).toISOString(), { zone: 'utc' }).setZone(tz).toFormat('HH:mm')}`,
        rakning: rakning.get(o.id),
        beslutad: poll.decided_option === o.id,
      })),
      // Namn visas så deltagarna ser vilka som svarat, men aldrig e-postadresser.
      svarande: poll.hide_names
        ? []
        : poll.participants
            .filter((p) => p.responded_at)
            .map((p) => ({ name: p.name, org: p.org, svar: svarPerDeltagare.get(p.id) || {} })),
      hideNames: poll.hide_names,
      jag: jag ? { name: jag.name, org: jag.org, svar: egnaSvar } : null,
      beslutadTid: beslutad
        ? formatSwedish(new Date(beslutad.start_utc).toISOString(), new Date(beslutad.end_utc).toISOString(), tz)
        : null,
      joinUrl: poll.decided_join,
      today: DateTime.now().setZone(TZ).setLocale('sv').toFormat('cccc d LLLL yyyy'),
    });
  });

  router.post('/api/poll/:token/vote', async (req, res) => {
    if (!rateLimit(`vote:${req.ip}`, 30, 10 * 60_000)) return bad(res, 429, 'För många försök. Försök igen senare.');

    const poll = await loadPollByToken(str(req.params.token, 80));
    if (!poll) return bad(res, 404, 'Omröstningen finns inte');
    if (poll.status !== 'open') return bad(res, 409, 'Omröstningen är stängd och tar inte emot fler svar.');

    const egenToken = str(req.body?.svarToken, 80);
    let deltagare = egenToken ? poll.participants.find((p) => p.token === egenToken) : null;

    const name = str(req.body?.name, 120) || deltagare?.name;
    const email = (str(req.body?.email, 254) || deltagare?.email || '').toLowerCase();
    if (!name || name.length < 2) return bad(res, 400, 'Ange ditt namn');
    if (!isEmail(email)) return bad(res, 400, 'Ange en giltig e-postadress');

    if (!deltagare) {
      const { rows } = await q(
        `INSERT INTO poll_participants (poll_id, name, email, org, token)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (poll_id, lower(email))
           DO UPDATE SET name = EXCLUDED.name, org = COALESCE(EXCLUDED.org, poll_participants.org)
         RETURNING *`,
        [poll.id, name, email, str(req.body?.org, 160) || null, randomToken(18)]
      );
      deltagare = rows[0];
    } else if (name !== deltagare.name) {
      await q('UPDATE poll_participants SET name = $2 WHERE id = $1', [deltagare.id, name]);
    }

    const svar = req.body?.svar && typeof req.body.svar === 'object' ? req.body.svar : {};
    const giltiga = new Set(poll.options.map((o) => o.id));
    let sparade = 0;
    for (const [optionId, answer] of Object.entries(svar)) {
      const id = int(optionId);
      if (!giltiga.has(id)) continue;
      if (!['ja', 'kanske', 'nej'].includes(answer)) continue;
      await q(
        `INSERT INTO poll_votes (option_id, participant_id, answer) VALUES ($1,$2,$3)
         ON CONFLICT (option_id, participant_id)
           DO UPDATE SET answer = EXCLUDED.answer, answered_at = now()`,
        [id, deltagare.id, answer]
      );
      sparade++;
    }
    if (!sparade) return bad(res, 400, 'Svara på minst en tid');

    await q('UPDATE poll_participants SET responded_at = now() WHERE id = $1', [deltagare.id]);

    // Kvitto med de valda tiderna och en kalenderfil för preliminärbokning.
    const { publikOrganisation } = require('./admin-routes');
    const org = await publikOrganisation().catch(() => ({}));
    const val = poll.options
      .filter((o) => svar[o.id])
      .map((o) => ({ option: o, answer: svar[o.id] }))
      .sort((a, b) => new Date(a.option.start_utc) - new Date(b.option.start_utc));

    const kvitto = await mail.sendPollVoteReceipt({
      poll,
      host: { name: poll.host_name, email: poll.host_email },
      participant: deltagare,
      val,
      kanskeText: org.kanskeText || 'Om jag måste',
      url: `${pollUrl(poll.public_token)}?svar=${deltagare.token}`,
    });

    await audit(email, 'poll_voted', {
      pollId: poll.id,
      antalSvar: sparade,
      kvittoSkickat: kvitto.sent,
      reserverade: kvitto.reserverade || 0,
    });

    res.json({
      ok: true,
      sparade,
      kvittoSkickat: kvitto.sent,
      svarUrl: `${pollUrl(poll.public_token)}?svar=${deltagare.token}`,
    });
  });

  return { syncHolds, releaseHolds };
};
