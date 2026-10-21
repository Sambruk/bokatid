'use strict';
// Bokning om ett ämne: en tjänst eller ett projekt ur CRM:et (se crm-synk.js).
// Besökaren väljer vad ärendet gäller, inte vem hen ska träffa. Tider visas när
// minst en av de ansvariga är ledig, och mötet läggs hos en av dem som är ledig
// då — den som haft minst ämnesbokningar på sistone (rundgång).

const { DateTime } = require('luxon');
const { q } = require('./db');
const { isSlotAvailable, unionDays } = require('./slots');
const feedSync = require('./feed-sync');
const { SYSTEM_TYP } = require('./crm-synk');

const RUNDGANG_DAGAR = 30;

module.exports = function amneRoutes({ router, helpers }) {
  const { bad, str, rateLimit, loadSchedule, busyFor, slotsForHosts, skapaBokning, TZ } = helpers;

  const idag = () => DateTime.now().setZone(TZ).setLocale('sv').toFormat('cccc d LLLL yyyy');
  const fotoUrl = (f) => (f ? `media/${f}` : null);

  /**
   * Ämnet med sina bokningsbara ansvariga: aktiva användare (inte externa) med en
   * aktiv system-mötestyp, i CRM:ets ordning — den tilldelade först.
   */
  async function hamtaAmne(slug) {
    const { rows } = await q('SELECT * FROM amnen WHERE slug = $1 AND aktiv', [slug]);
    const amne = rows[0];
    if (!amne) return null;
    const { rows: vardar } = await q(
      `SELECT u.id, u.name, u.email, u.title, u.slug, u.timezone, u.photo_file,
              u.feed_url, u.feed_checked_at, u.feed_error, row_to_json(e) AS et
       FROM users u JOIN event_types e ON e.user_id = u.id AND e.system_typ = $2 AND e.active
       WHERE u.active AND u.role <> 'extern' AND lower(u.email) = ANY ($1::text[])
       ORDER BY array_position($1::text[], lower(u.email))`,
      [amne.ansvariga_epost, SYSTEM_TYP]
    );
    return { amne, vardar };
  }

  const publikVard = (v) => ({ name: v.name, title: v.title, slug: v.slug, photoUrl: fotoUrl(v.photo_file) });

  router.get('/api/amnen', async (req, res) => {
    const { rows } = await q(
      `SELECT a.slug, a.namn, a.typ, a.korttext,
              json_agg(json_build_object('name', u.name, 'title', u.title, 'slug', u.slug, 'photo_file', u.photo_file)
                       ORDER BY array_position(a.ansvariga_epost, lower(u.email))) AS vardar
       FROM amnen a
       JOIN users u ON lower(u.email) = ANY (a.ansvariga_epost) AND u.active AND u.role <> 'extern'
       JOIN event_types e ON e.user_id = u.id AND e.system_typ = $1 AND e.active
       WHERE a.aktiv
       GROUP BY a.crm_id
       ORDER BY a.namn`,
      [SYSTEM_TYP]
    );
    res.json({
      amnen: rows.map((r) => ({
        slug: r.slug,
        namn: r.namn,
        typ: r.typ,
        korttext: r.korttext,
        vardar: r.vardar.map((v) => ({ name: v.name, title: v.title, slug: v.slug, photoUrl: fotoUrl(v.photo_file) })),
      })),
      today: idag(),
    });
  });

  router.get('/api/amnen/:slug', async (req, res) => {
    const hittat = await hamtaAmne(str(req.params.slug, 80));
    if (!hittat || !hittat.vardar.length) return bad(res, 404, 'Det finns ingen bokningsbar tjänst eller projekt med det namnet');
    const { amne, vardar } = hittat;

    /*
     * Värdarnas mötestyper kan skilja sig åt. Frågorna slås ihop per nyckel och
     * räknas som obligatoriska om någon av dem kräver svar — vilken värd som får
     * mötet avgörs först vid bokningen.
     */
    const fragor = new Map();
    for (const v of vardar) {
      for (const f of v.et.questions || []) {
        const fanns = fragor.get(f.key);
        fragor.set(f.key, fanns ? { ...fanns, required: fanns.required || f.required } : f);
      }
    }
    const forsta = vardar[0].et;
    res.json({
      amne: { slug: amne.slug, namn: amne.namn, typ: amne.typ, korttext: amne.korttext },
      vardar: vardar.map(publikVard),
      eventType: {
        title: `Samtal om ${amne.namn}`,
        duration_min: forsta.duration_min,
        location_type: forsta.location_type,
        location_text: forsta.location_type === 'physical' ? forsta.location_text : null,
        questions: [...fragor.values()],
      },
      timezone: TZ,
      today: idag(),
    });
  });

  router.get('/api/amnen/:slug/slots', async (req, res) => {
    const hittat = await hamtaAmne(str(req.params.slug, 80));
    if (!hittat || !hittat.vardar.length) return bad(res, 404, 'Finns inte');
    const { vardar } = hittat;

    const tz = TZ;
    const today = DateTime.now().setZone(tz).startOf('day');
    let from = DateTime.fromISO(str(req.query.from, 10), { zone: tz });
    if (!from.isValid || from < today) from = today;
    let to = DateTime.fromISO(str(req.query.to, 10), { zone: tz });
    if (!to.isValid) to = from.plus({ days: 13 });
    if (to > from.plus({ days: 30 })) to = from.plus({ days: 30 });
    const maxDate = today.plus({ days: Math.max(...vardar.map((v) => v.et.max_days_ahead)) });
    if (to > maxDate) to = maxDate;
    if (to < from) return res.json({ days: [], calendarChecked: false });

    const perVard = [];
    let calendarChecked = true;
    for (const v of vardar) {
      const { days, calendarChecked: kollad } = await slotsForHosts({
        hosts: [v],
        eventType: v.et,
        tz,
        fromDate: from.toISODate(),
        toDate: to.toISODate(),
        fromIso: from.startOf('day').toUTC().toISO(),
        toIso: to.endOf('day').toUTC().toISO(),
      });
      if (!kollad) calendarChecked = false;
      perVard.push(days);
    }

    res.json({
      // Vem som är ledig vid en viss tid lämnas inte ut; det avgörs vid bokningen.
      days: unionDays(perVard).map((d) => ({
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

  router.post('/api/amnen/:slug/book', async (req, res) => {
    const kvot = req.agent ? `book:agent:${req.agent.tokenId}` : `book:${req.ip || 'okänd'}`;
    if (!rateLimit(kvot, req.agent ? 20 : 10, 10 * 60_000)) return bad(res, 429, 'För många bokningsförsök. Försök igen senare.');
    if (req.agent && !req.agent.scopes.includes('boka')) return bad(res, 403, 'Nyckeln saknar behörigheten "boka"');

    const hittat = await hamtaAmne(str(req.params.slug, 80));
    if (!hittat || !hittat.vardar.length) return bad(res, 404, 'Finns inte');
    const { amne, vardar } = hittat;

    const start = DateTime.fromISO(str(req.body?.start, 40), { zone: 'utc' });
    if (!start.isValid) return bad(res, 400, 'Ogiltig tid');

    // Vilka ansvariga är lediga vid den valda tiden?
    const lediga = [];
    for (const v of vardar) {
      if (v.feed_url) await feedSync.uppdateraOmGammal(v, 2);
      const slut = start.plus({ minutes: v.et.duration_min });
      const { rules, overrides } = await loadSchedule(v);
      const { busy, booked } = await busyFor(v, start.minus({ days: 1 }).toISO(), slut.plus({ days: 1 }).toISO());
      if (isSlotAvailable({ timezone: v.timezone || TZ, rules, overrides, eventType: v.et, busy, booked }, start.toUTC().toISO())) {
        lediga.push(v);
      }
    }
    if (!lediga.length) return bad(res, 409, 'Tiden är inte längre ledig. Välj en annan tid.');

    // Rundgång: minst antal ämnesbokningar de senaste dagarna. Vid lika vinner
    // CRM:ets ordning, alltså den tilldelade.
    const { rows: antal } = await q(
      `SELECT user_id, count(*)::int AS n FROM bookings
       WHERE amne_id IS NOT NULL AND status = 'confirmed' AND user_id = ANY ($1::int[])
         AND created_at > now() - ($2 || ' days')::interval
       GROUP BY user_id`,
      [lediga.map((v) => v.id), String(RUNDGANG_DAGAR)]
    );
    const nFor = new Map(antal.map((r) => [r.user_id, r.n]));
    const vald = valjVard(lediga, nFor);

    return skapaBokning(req, res, {
      host: vald,
      eventType: { ...vald.et, title: `Samtal om ${amne.namn}` },
      hosts: [vald],
      amne,
    });
  });
};

/** Den lediga värd som har minst bokningar; vid lika den som står först. */
function valjVard(lediga, nFor) {
  return lediga.reduce((bast, v) => ((nFor.get(v.id) || 0) < (nFor.get(bast.id) || 0) ? v : bast));
}

module.exports.valjVard = valjVard;
