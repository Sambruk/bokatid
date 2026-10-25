'use strict';
// Svenska röda dagar, framräknade enligt lagen (1989:253) om allmänna
// helgdagar: https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-1989253-om-allmanna-helgdagar_sfs-1989-253/
// Ingen nätverkskälla behövs — lagen anger fasta datum, påsken och regler för
// de rörliga dagarna. Söndagar är också allmänna helgdagar men finns inte med
// här; de styrs av veckoschemat.
//
// Midsommarafton, julafton och nyårsafton är inte allmänna helgdagar, men
// arbetstidslagen (1982:673) 4 § likställer dem med söndag. De räknas därför
// också som stängda.

const { DateTime } = require('luxon');

/** Påskdagen enligt den gregorianska beräkningen (Meeus/Jones/Butcher). */
function paskdagen(ar) {
  const a = ar % 19;
  const b = Math.floor(ar / 100);
  const c = ar % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const manad = Math.floor((h + l - 7 * m + 114) / 31);
  const dag = ((h + l - 7 * m + 114) % 31) + 1;
  return DateTime.utc(ar, manad, dag);
}

/** Den dag i intervallet [fran, till] (dag i månaden) som infaller på veckodagen. */
function veckodagMellan(ar, manad, fran, veckodag) {
  for (let d = fran; d < fran + 7; d++) {
    const dt = DateTime.utc(ar, manad, 1).plus({ days: d - 1 });
    if (dt.weekday === veckodag) return dt;
  }
  throw new Error('omöjligt');
}

/**
 * Röda dagar ett visst år, sorterade: [{ datum: 'YYYY-MM-DD', namn, afton }].
 * afton = true för de dagar som bara likställs med söndag.
 */
function helgdagarAr(ar) {
  const pask = paskdagen(ar);
  const lista = [
    [DateTime.utc(ar, 1, 1), 'Nyårsdagen'],
    [DateTime.utc(ar, 1, 6), 'Trettondedag jul'],
    [pask.minus({ days: 2 }), 'Långfredagen'],
    [pask, 'Påskdagen'],
    [pask.plus({ days: 1 }), 'Annandag påsk'],
    [DateTime.utc(ar, 5, 1), 'Första maj'],
    [pask.plus({ days: 39 }), 'Kristi himmelsfärdsdag'],
    [pask.plus({ days: 49 }), 'Pingstdagen'],
    [DateTime.utc(ar, 6, 6), 'Sveriges nationaldag'],
    // Midsommardagen: lördagen 20–26 juni. Alla helgons dag: lördagen 31 okt–6 nov.
    [veckodagMellan(ar, 6, 20, 6), 'Midsommardagen'],
    [veckodagMellan(ar, 10, 31, 6), 'Alla helgons dag'],
    [DateTime.utc(ar, 12, 25), 'Juldagen'],
    [DateTime.utc(ar, 12, 26), 'Annandag jul'],
  ].map(([dt, namn]) => ({ datum: dt.toISODate(), namn, afton: false }));

  const midsommardagen = veckodagMellan(ar, 6, 20, 6);
  lista.push(
    { datum: midsommardagen.minus({ days: 1 }).toISODate(), namn: 'Midsommarafton', afton: true },
    { datum: DateTime.utc(ar, 12, 24).toISODate(), namn: 'Julafton', afton: true },
    { datum: DateTime.utc(ar, 12, 31).toISODate(), namn: 'Nyårsafton', afton: true }
  );
  return lista.sort((x, y) => x.datum.localeCompare(y.datum));
}

/** Röda dagar mellan två datum (inklusive), 'YYYY-MM-DD'. */
function helgdagarMellan(fran, till) {
  const ut = [];
  for (let ar = Number(fran.slice(0, 4)); ar <= Number(till.slice(0, 4)); ar++) {
    for (const h of helgdagarAr(ar)) if (h.datum >= fran && h.datum <= till) ut.push(h);
  }
  return ut;
}

/**
 * Lägger in röda dagar som stängda undantag. Värdens egna undantag vinner, så
 * den som vill ta emot bokningar en röd dag lägger ett undantag med tider.
 */
function medHelgdagar(overrides, fran, till) {
  const egna = new Set(overrides.map((o) => String(o.on_date).slice(0, 10)));
  const roda = helgdagarMellan(fran, till)
    .filter((h) => !egna.has(h.datum))
    .map((h) => ({ on_date: h.datum, unavailable: true, start_min: null, end_min: null, note: h.namn, helgdag: true }));
  return [...overrides, ...roda].sort((a, b) => String(a.on_date).localeCompare(String(b.on_date)));
}

module.exports = { paskdagen, helgdagarAr, helgdagarMellan, medHelgdagar };
