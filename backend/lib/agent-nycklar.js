'use strict';
// Agentnycklar: personliga nycklar som låter en AI-agent använda tjänsten för en
// användares räkning, via /mcp eller de vitlistade delarna av REST-API:t.
//
// Säkerhetsmodellen:
// - Nyckeln visas en gång. I databasen finns bara dess SHA-256 och ett kort prefix.
// - En nyckel är knuten till en användare och ger aldrig mer än den användaren har,
//   och bara det som behörigheterna (scopes) tillåter.
// - Nycklar har alltid ett utgångsdatum och kan spärras med omedelbar verkan
//   (varje anrop slår upp nyckeln i databasen, inget cachas).
// - Nycklar skapas och spärras bara med en inloggad session — aldrig av en agent.

const { q } = require('./db');
const { randomToken, hashToken } = require('./crypto');

const PREFIX = 'bt_';

const BEHORIGHETER = {
  las: 'Läsa tjänster, lediga tider och dina egna bokningar',
  boka: 'Boka tider hos tjänsterna åt någon annan',
  avboka: 'Avboka dina egna bokningar',
  omrostning:
    'Skapa och sköta omröstningar om mötestid: reservera tid i din kalender, mejla inbjudningar och påminnelser, besluta och avbryta',
};

const STANDARD_DAGAR = 90;
const MAX_DAGAR = 365;

// De enda delarna av admin-API:t som en agentnyckel släpps in på, och vilka
// behörigheter som var och en godtar (någon av dem räcker). Allt annat
// (lösenord, mötestyper, användare, nycklarna själva …) kräver inloggning.
// Att ta bort och rensa omröstningar lämnas medvetet utanför: det är manuellt.
const AGENT_RUTTER = {
  'GET /api/admin/bookings': ['las'],
  'POST /api/admin/bookings/:id/cancel': ['avboka'],
  // Läsa omröstningar räcker med las; den som får sköta dem får också se dem.
  'GET /api/admin/poll-slots': ['las', 'omrostning'],
  'GET /api/admin/polls': ['las', 'omrostning'],
  'GET /api/admin/polls/:id': ['las', 'omrostning'],
  'POST /api/admin/polls': ['omrostning'],
  'POST /api/admin/polls/:id/participants': ['omrostning'],
  'POST /api/admin/polls/:id/remind': ['omrostning'],
  'POST /api/admin/polls/:id/decide': ['omrostning'],
  'POST /api/admin/polls/:id/cancel': ['omrostning'],
};

/** Ny nyckel. Själva nyckeln returneras bara här och sparas aldrig. */
function nyNyckel() {
  const nyckel = PREFIX + randomToken(32);
  return { nyckel, hash: hashToken(nyckel), prefix: nyckel.slice(0, 10) };
}

/** Plockar nyckeln ur en Authorization-header. Null om headern inte är en agentnyckel. */
function lasBearer(header) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header || '');
  if (!m) return null;
  return m[1].startsWith(PREFIX) ? m[1] : null;
}

/** Kontrollerar och normaliserar det som skickas in när en nyckel skapas. */
function tolkaNyNyckel(body) {
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
  if (name.length < 2) return { fel: 'Ge nyckeln ett namn, t.ex. vilken agent den är till' };

  const scopes = Array.isArray(body?.scopes) ? [...new Set(body.scopes)] : [];
  if (!scopes.length) return { fel: 'Välj minst en behörighet' };
  const okand = scopes.find((s) => !Object.hasOwn(BEHORIGHETER, s));
  if (okand) return { fel: `Okänd behörighet: ${String(okand).slice(0, 40)}` };

  const dagar = body?.dagar === undefined ? STANDARD_DAGAR : Math.trunc(Number(body.dagar));
  if (!Number.isFinite(dagar) || dagar < 1 || dagar > MAX_DAGAR) {
    return { fel: `Giltighetstiden ska vara 1–${MAX_DAGAR} dagar` };
  }
  return { name, scopes: scopes.sort(), dagar };
}

/** Behörigheterna en admin-rutt godtar av en agent, eller null om agenter inte släpps in. */
function behorighetForRutt(method, routePath) {
  return AGENT_RUTTER[`${method} ${routePath}`] || null;
}

/** Om nyckelns behörigheter räcker för något av kraven. */
function tillater(scopes, krav) {
  return krav.some((k) => scopes.includes(k));
}

async function skapa(userId, { name, scopes, dagar }) {
  const { nyckel, hash, prefix } = nyNyckel();
  const { rows } = await q(
    `INSERT INTO api_tokens (user_id, name, token_hash, prefix, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
     RETURNING id, name, prefix, scopes, expires_at, created_at`,
    [userId, name, hash, prefix, scopes, dagar]
  );
  return { ...rows[0], nyckel };
}

async function lista(userId) {
  const { rows } = await q(
    `SELECT id, name, prefix, scopes, expires_at, revoked_at, last_used_at, created_at,
            (revoked_at IS NULL AND expires_at > now()) AS giltig
     FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

async function sparra(userId, id) {
  const { rowCount } = await q(
    'UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [id, userId]
  );
  return rowCount > 0;
}

// last_used_at skrivs högst var femte minut per nyckel, inte vid varje anrop.
const senastSkrivet = new Map();

/** Slår upp en nyckel. Null om den inte finns, är spärrad, har gått ut eller användaren är avstängd. */
async function slaUpp(nyckel) {
  const { rows } = await q(
    `SELECT t.id AS token_id, t.name AS token_name, t.scopes, u.*
     FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > now() AND u.active`,
    [hashToken(nyckel)]
  );
  const rad = rows[0];
  if (!rad) return null;

  const { token_id: tokenId, token_name: tokenName, scopes, ...user } = rad;
  const nu = Date.now();
  if (nu - (senastSkrivet.get(tokenId) || 0) > 5 * 60_000) {
    senastSkrivet.set(tokenId, nu);
    q('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [tokenId]).catch(() => {});
  }
  return { tokenId, tokenName, scopes, user };
}

module.exports = {
  BEHORIGHETER,
  STANDARD_DAGAR,
  MAX_DAGAR,
  nyNyckel,
  lasBearer,
  tolkaNyNyckel,
  behorighetForRutt,
  tillater,
  skapa,
  lista,
  sparra,
  slaUpp,
};
