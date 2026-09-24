'use strict';
// Slotmotorn. Här bor all tidslogik, och ingenting annat: modulen känner inte
// till databasen eller HTTP, så den går att enhetstesta.
//
// Grundregel: lediga tider räknas fram i värdens lokala tidszon och returneras
// i UTC. Veckoschemat är "09:00 lokal tid", inte ett UTC-klockslag — annars
// glider alla tider en timme vid sommartidsskiftet.

const { DateTime, Interval } = require('luxon');

/**
 * @param {object} p
 * @param {string} p.timezone            t.ex. 'Europe/Stockholm'
 * @param {Array}  p.rules               [{weekday 1-7, start_min, end_min}]
 * @param {Array}  p.overrides           [{on_date 'YYYY-MM-DD', unavailable, start_min, end_min}]
 * @param {object} p.eventType           {duration_min, buffer_before, buffer_after,
 *                                        slot_step_min, min_notice_min, max_days_ahead, max_per_day}
 * @param {Array}  p.busy                [{start: ISO|Date, end: ISO|Date}] — bokningar och upptaget i kalendern
 * @param {string} p.fromDate            'YYYY-MM-DD' (lokalt datum, inklusive)
 * @param {string} p.toDate              'YYYY-MM-DD' (lokalt datum, inklusive)
 * @param {Date}   [p.now]
 * @returns {Array<{date: string, slots: Array<{start: string, end: string}>}>}
 */
function availableSlots(p) {
  const tz = p.timezone || 'Europe/Stockholm';
  const et = p.eventType;
  const now = DateTime.fromJSDate(p.now ? new Date(p.now) : new Date()).setZone(tz);

  const duration = et.duration_min;
  const bufBefore = et.buffer_before || 0;
  const bufAfter = et.buffer_after || 0;
  const step = et.slot_step_min || 30;

  const earliest = now.plus({ minutes: et.min_notice_min || 0 });
  const latest = now.plus({ days: et.max_days_ahead || 60 }).endOf('day');

  const busy = (p.busy || [])
    .map((b) => Interval.fromDateTimes(toDT(b.start, tz), toDT(b.end, tz)))
    .filter((iv) => iv.isValid);

  const overrideByDate = new Map();
  for (const o of p.overrides || []) overrideByDate.set(dateKey(o.on_date), o);

  const rulesByWeekday = new Map();
  for (const r of p.rules || []) {
    if (!rulesByWeekday.has(r.weekday)) rulesByWeekday.set(r.weekday, []);
    rulesByWeekday.get(r.weekday).push(r);
  }

  const out = [];
  let day = DateTime.fromISO(p.fromDate, { zone: tz }).startOf('day');
  const lastDay = DateTime.fromISO(p.toDate, { zone: tz }).startOf('day');
  if (!day.isValid || !lastDay.isValid) throw new Error('Ogiltigt datumintervall');

  let guard = 0;
  while (day <= lastDay && guard++ < 400) {
    const key = day.toISODate();
    const windows = windowsForDate(day, overrideByDate.get(key), rulesByWeekday);
    const slots = [];

    if (windows.length && withinDayLimit(day, busy, et.max_per_day)) {
      for (const w of windows) {
        for (let m = w.start_min; m + duration <= w.end_min; m += step) {
          const start = atMinutes(day, m, tz);
          // Icke-existerande lokal tid (timmen som hoppas över i mars) hoppas över.
          if (!start || start.minute !== m % 60 || start.hour !== Math.floor(m / 60)) continue;
          const end = start.plus({ minutes: duration });

          if (start < earliest) continue;
          if (start > latest) continue;

          const blocked = Interval.fromDateTimes(
            start.minus({ minutes: bufBefore }),
            end.plus({ minutes: bufAfter })
          );
          if (busy.some((iv) => iv.overlaps(blocked))) continue;

          slots.push({ start: start.toUTC().toISO(), end: end.toUTC().toISO() });
        }
      }
    }

    // Dubbletter kan uppstå om två regler för samma veckodag överlappar.
    const seen = new Set();
    const unique = slots.filter((s) => (seen.has(s.start) ? false : seen.add(s.start)));
    unique.sort((a, b) => a.start.localeCompare(b.start));
    out.push({ date: key, slots: unique });
    day = day.plus({ days: 1 });
  }
  return out;
}

function windowsForDate(day, override, rulesByWeekday) {
  if (override) {
    if (override.unavailable) return [];
    if (override.start_min != null && override.end_min != null) {
      return [{ start_min: override.start_min, end_min: override.end_min }];
    }
  }
  return (rulesByWeekday.get(day.weekday) || []).map((r) => ({
    start_min: r.start_min,
    end_min: r.end_min,
  }));
}

// Tak för antal möten per dag räknas på värdens lokala dygn.
function withinDayLimit(day, busy, maxPerDay) {
  if (!maxPerDay) return true;
  const dayIv = Interval.fromDateTimes(day, day.plus({ days: 1 }));
  const count = busy.filter((iv) => iv.overlaps(dayIv)).length;
  return count < maxPerDay;
}

function atMinutes(day, minutes, tz) {
  const dt = day.set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 });
  return dt.isValid ? dt.setZone(tz) : null;
}

function toDT(v, tz) {
  if (v instanceof Date) return DateTime.fromJSDate(v).setZone(tz);
  return DateTime.fromISO(String(v), { zone: 'utc' }).setZone(tz);
}

function dateKey(v) {
  if (v instanceof Date) return DateTime.fromJSDate(v, { zone: 'utc' }).toISODate();
  return String(v).slice(0, 10);
}

/** Kontrollerar att en föreslagen starttid verkligen är en av de lediga tiderna. */
function isSlotAvailable(p, startIso) {
  const tz = p.timezone || 'Europe/Stockholm';
  const local = DateTime.fromISO(startIso, { zone: 'utc' }).setZone(tz);
  if (!local.isValid) return false;
  const days = availableSlots({ ...p, fromDate: local.toISODate(), toDate: local.toISODate() });
  const wanted = local.toUTC().toISO();
  return days.some((d) => d.slots.some((s) => s.start === wanted));
}

/**
 * Snittet av flera värdars lediga tider. En tid erbjuds bara när den finns hos
 * samtliga — det är innebörden av en bokningstjänst med flera värdar.
 *
 * @param {Array<Array<{date: string, slots: Array<{start: string, end: string}>}>>} perVard
 *        En lista per värd, i den form availableSlots returnerar.
 */
function intersectDays(perVard) {
  if (!perVard || !perVard.length) return [];
  const [forsta, ...ovriga] = perVard;

  /*
   * Snittet räknas per dag, inte på starttiderna i en enda hög. Skillnaden
   * spelar roll om en värd inte har dagen med alls: då ska dagen bli tom, inte
   * ärva en annan dags tider. Alla värdar frågas i dag med samma datumintervall,
   * men logiken ska inte vila på det antagandet.
   */
  const perDagOchVard = ovriga.map((vard) => {
    const karta = new Map();
    for (const d of vard) karta.set(d.date, new Set(d.slots.map((s) => s.start)));
    return karta;
  });

  return forsta.map((d) => ({
    date: d.date,
    slots: d.slots.filter((s) =>
      perDagOchVard.every((karta) => karta.get(d.date)?.has(s.start))
    ),
  }));
}

/** Svensk formatering för e-post och webbsidor: "torsdag 24 september 2026, 09:00–09:30". */
function formatSwedish(startIso, endIso, tz = 'Europe/Stockholm') {
  const s = DateTime.fromISO(startIso, { zone: 'utc' }).setZone(tz).setLocale('sv');
  const e = DateTime.fromISO(endIso, { zone: 'utc' }).setZone(tz).setLocale('sv');
  return `${s.toFormat("cccc d LLLL yyyy',' HH:mm")}–${e.toFormat('HH:mm')}`;
}

module.exports = { availableSlots, isSlotAvailable, intersectDays, formatSwedish };
