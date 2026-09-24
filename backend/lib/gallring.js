'use strict';
// Automatisk gallring. Tjänsten sparar namn, e-postadresser och svar på frågor
// om personer som bokat eller röstat. De uppgifterna behövs för att genomföra
// mötet, inte i all framtid, så de raderas när tiden gått.
//
// Körs i appens egen process en gång per dygn. Ingen cron behövs — containern
// har restart: always — men jobbet körs också vid start, så en server som varit
// nere hinner ikapp.

const { q, audit } = require('./db');

const DYGN = 24 * 60 * 60 * 1000;

function dagar(namn, standard) {
  const v = Number(process.env[namn]);
  if (!Number.isFinite(v) || v < 0) return standard;
  return Math.min(Math.trunc(v), 3650);
}

/** 0 betyder avstängt för den kategorin, inte "radera allt". */
function inställningar() {
  return {
    bokningar: dagar('GALLRING_BOKNINGAR_DAGAR', 90),
    omrostningar: dagar('GALLRING_OMROSTNINGAR_DAGAR', 90),
    logg: dagar('GALLRING_LOGG_DAGAR', 365),
  };
}

async function gallra({ torrkörning = false } = {}) {
  const inst = inställningar();
  const resultat = { ...inst, bokningarBorttagna: 0, omrostningarBorttagna: 0, loggposterBorttagna: 0, torrkörning };

  // Bokningar räknas från mötets sluttid, inte från när den skapades.
  if (inst.bokningar > 0) {
    const sql = `FROM bookings WHERE end_utc < now() - ($1 || ' days')::interval`;
    if (torrkörning) {
      const { rows } = await q(`SELECT count(*)::int AS n ${sql}`, [String(inst.bokningar)]);
      resultat.bokningarBorttagna = rows[0].n;
    } else {
      const { rowCount } = await q(`DELETE ${sql}`, [String(inst.bokningar)]);
      resultat.bokningarBorttagna = rowCount;
    }
  }

  /*
   * Bara avslutade omröstningar gallras. En öppen väntar fortfarande på svar och
   * håller dessutom reservationer i kalendern — den ska en människa avgöra.
   * Reservationer på en avslutad omröstning är redan släppta; skulle någon ha
   * blivit kvar loggas det nedan i stället för att raderas tyst.
   */
  if (inst.omrostningar > 0) {
    const villkor = `FROM polls WHERE status IN ('decided','cancelled')
       AND COALESCE(decided_at, closed_at, created_at) < now() - ($1 || ' days')::interval`;
    if (torrkörning) {
      const { rows } = await q(`SELECT count(*)::int AS n ${villkor}`, [String(inst.omrostningar)]);
      resultat.omrostningarBorttagna = rows[0].n;
    } else {
      const { rows: kvarglomda } = await q(
        `SELECT count(*)::int AS n FROM poll_options o
         WHERE o.graph_event_id IS NOT NULL AND o.poll_id IN (SELECT id ${villkor})`,
        [String(inst.omrostningar)]
      );
      if (kvarglomda[0].n) {
        resultat.kvarglomdaReservationer = kvarglomda[0].n;
        await audit('system', 'gallring_kvarglomda_reservationer', { antal: kvarglomda[0].n });
      }
      const { rowCount } = await q(`DELETE ${villkor}`, [String(inst.omrostningar)]);
      resultat.omrostningarBorttagna = rowCount;
    }
  }

  // Granskningsloggen innehåller e-postadresser i actor-fältet.
  if (inst.logg > 0) {
    const sql = `FROM audit_log WHERE at < now() - ($1 || ' days')::interval`;
    if (torrkörning) {
      const { rows } = await q(`SELECT count(*)::int AS n ${sql}`, [String(inst.logg)]);
      resultat.loggposterBorttagna = rows[0].n;
    } else {
      const { rowCount } = await q(`DELETE ${sql}`, [String(inst.logg)]);
      resultat.loggposterBorttagna = rowCount;
    }
  }

  const nagotHande =
    resultat.bokningarBorttagna || resultat.omrostningarBorttagna || resultat.loggposterBorttagna;
  if (!torrkörning && nagotHande) {
    await audit('system', 'gallring', resultat);
  }
  return resultat;
}

/** Startar dygnsjobbet och kör en gallring direkt. */
function startaGallring() {
  const inst = inställningar();
  console.log(
    `Gallring: bokningar ${inst.bokningar || 'av'} dagar, omröstningar ${inst.omrostningar || 'av'} dagar, ` +
      `logg ${inst.logg || 'av'} dagar`
  );

  const kör = () =>
    gallra()
      .then((r) => {
        if (r.bokningarBorttagna || r.omrostningarBorttagna || r.loggposterBorttagna) {
          console.log(
            `Gallring klar: ${r.bokningarBorttagna} bokningar, ${r.omrostningarBorttagna} omröstningar, ` +
              `${r.loggposterBorttagna} loggposter borttagna`
          );
        }
      })
      .catch((err) => console.error('Gallringen misslyckades:', err.message));

  kör();
  const timer = setInterval(kör, DYGN);
  timer.unref();
  return timer;
}

module.exports = { gallra, startaGallring, inställningar };
