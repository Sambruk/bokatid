'use strict';
// Håller prenumererade kalendrar aktuella.
//
// Upptagna tider sparas i databasen i stället för att hämtas vid varje
// sidvisning. Två skäl: en bokningssida ska inte vänta på någon annans server,
// och går leverantörens kalender inte att nå ska tjänsten använda det senast
// kända i stället för att visa deras bokade tider som lediga.

const { q, audit } = require('./db');
const { hamtaUpptaget } = require('./ics-feed');

const FONSTER_DAGAR = 120;
const UPPDATERA_VAR_MINUT = 15;

/** Hämtar en användares kalender och ersätter de sparade tiderna. */
async function uppdatera(user) {
  if (!user.feed_url) return { ok: false, skal: 'ingen prenumeration' };

  const fromIso = new Date(Date.now() - 86400_000).toISOString();
  const toIso = new Date(Date.now() + FONSTER_DAGAR * 86400_000).toISOString();

  try {
    const upptaget = await hamtaUpptaget(user.feed_url, { fromIso, toIso });

    // Byts ut i en transaktion: annars finns ett ögonblick utan tider alls,
    // och då kan en bokning slinka igenom på en upptagen tid.
    const client = await require('./db').pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM feed_busy WHERE user_id = $1', [user.id]);
      for (const b of upptaget) {
        await client.query('INSERT INTO feed_busy (user_id, start_utc, end_utc) VALUES ($1,$2,$3)', [
          user.id,
          b.start,
          b.end,
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await q('UPDATE users SET feed_checked_at = now(), feed_error = NULL WHERE id = $1', [user.id]);
    return { ok: true, antal: upptaget.length };
  } catch (err) {
    const text = String(err.message).slice(0, 300);
    await q('UPDATE users SET feed_checked_at = now(), feed_error = $2 WHERE id = $1', [user.id, text]);
    await audit('system', 'feed_fel', { userId: user.id, fel: text });
    return { ok: false, skal: text };
  }
}

/** Uppdaterar en användares kalender om den inte hämtats på ett tag. */
async function uppdateraOmGammal(user, minuter = UPPDATERA_VAR_MINUT) {
  if (!user.feed_url) return null;
  const alder = user.feed_checked_at ? (Date.now() - new Date(user.feed_checked_at).getTime()) / 60_000 : Infinity;
  if (alder < minuter) return null;
  return uppdatera(user);
}

/** Upptagna tider ur den sparade prenumerationen. */
async function sparadeTider(userId, fromIso, toIso) {
  const { rows } = await q(
    `SELECT start_utc AS start, end_utc AS end FROM feed_busy
     WHERE user_id = $1 AND end_utc > $2 AND start_utc < $3`,
    [userId, fromIso, toIso]
  );
  return rows.map((r) => ({ start: r.start, end: r.end }));
}

/** Uppdaterar alla prenumerationer. Körs i bakgrunden. */
async function uppdateraAlla() {
  const { rows } = await q('SELECT * FROM users WHERE active AND feed_url IS NOT NULL');
  let lyckade = 0;
  for (const user of rows) {
    const r = await uppdatera(user);
    if (r.ok) lyckade++;
  }
  return { antal: rows.length, lyckade };
}

function startaFeedSync() {
  const kor = () =>
    uppdateraAlla()
      .then((r) => {
        if (r.antal) console.log(`Kalenderprenumerationer uppdaterade: ${r.lyckade} av ${r.antal}`);
      })
      .catch((err) => console.error('Kunde inte uppdatera prenumerationer:', err.message));

  kor();
  const timer = setInterval(kor, UPPDATERA_VAR_MINUT * 60_000);
  timer.unref();
  return timer;
}

module.exports = { uppdatera, uppdateraOmGammal, sparadeTider, uppdateraAlla, startaFeedSync };
