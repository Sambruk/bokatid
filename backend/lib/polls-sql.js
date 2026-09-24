'use strict';
// Frågorna som hämtar omröstningar med förslag, deltagare och svar. Ligger för
// sig för att hålla server.js läsbar.

const { q } = require('./db');

/** En omröstning med allt som hör till, eller null. Alltid begränsad till en värd. */
async function loadPoll(pollId, userId = null) {
  const { rows } = await q(
    `SELECT p.*, u.name AS host_name, u.email AS host_email, u.title AS host_title,
            u.slug AS host_slug, u.timezone
     FROM polls p JOIN users u ON u.id = p.user_id
     WHERE p.id = $1 AND ($2::int IS NULL OR p.user_id = $2)`,
    [pollId, userId]
  );
  return rows[0] ? withParts(rows[0]) : null;
}

async function loadPollByToken(token) {
  const { rows } = await q(
    `SELECT p.*, u.name AS host_name, u.email AS host_email, u.title AS host_title,
            u.slug AS host_slug, u.timezone
     FROM polls p JOIN users u ON u.id = p.user_id
     WHERE p.public_token = $1`,
    [token]
  );
  return rows[0] ? withParts(rows[0]) : null;
}

async function withParts(poll) {
  const [options, participants, votes] = await Promise.all([
    q('SELECT * FROM poll_options WHERE poll_id = $1 ORDER BY start_utc', [poll.id]),
    q('SELECT * FROM poll_participants WHERE poll_id = $1 ORDER BY created_at, id', [poll.id]),
    q(
      `SELECT v.* FROM poll_votes v JOIN poll_options o ON o.id = v.option_id
       WHERE o.poll_id = $1`,
      [poll.id]
    ),
  ]);
  return { ...poll, options: options.rows, participants: participants.rows, votes: votes.rows };
}

/** Sammanställning per förslag: antal ja, kanske och nej. */
function tally(poll) {
  const per = new Map(poll.options.map((o) => [o.id, { ja: 0, kanske: 0, nej: 0 }]));
  for (const v of poll.votes) {
    const rad = per.get(v.option_id);
    if (rad) rad[v.answer] += 1;
  }
  return per;
}

/** Förslagen sorterade efter hur bra de passar: flest ja, sedan flest kanske. */
function ranked(poll) {
  const per = tally(poll);
  return [...poll.options]
    .map((o) => ({ ...o, rakning: per.get(o.id) }))
    .sort((a, b) =>
      b.rakning.ja - a.rakning.ja ||
      b.rakning.kanske - a.rakning.kanske ||
      a.rakning.nej - b.rakning.nej ||
      new Date(a.start_utc) - new Date(b.start_utc)
    );
}

module.exports = { loadPoll, loadPollByToken, tally, ranked };
