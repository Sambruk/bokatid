'use strict';
// Microsoft 365-koppling via Graph, delegerat (auth code + PKCE).
// Varje värd godkänner sin egen kalender — ingen behörighet över andras
// brevlådor begärs, och därmed behövs inget organisationsövergripande samtycke
// utöver det som tenanten kräver för Calendars.ReadWrite.
//
// Ingen MSAL-beroende: flödet är två HTTP-anrop och native fetch räcker.

const SCOPES = ['openid', 'profile', 'offline_access', 'User.Read', 'Calendars.ReadWrite'];
const GRAPH = 'https://graph.microsoft.com/v1.0';

function config() {
  return {
    tenant: process.env.MS_TENANT_ID || '',
    clientId: process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.MS_CLIENT_SECRET || '',
    redirectUri: `${(process.env.PUBLIC_URL || '').replace(/\/$/, '')}/auth/ms/callback`,
  };
}

/** Är kopplingen konfigurerad? Utan detta fungerar allt utom kalenderskrivning. */
function isConfigured() {
  const c = config();
  return Boolean(c.tenant && c.clientId && c.clientSecret);
}

function authorizeUrl({ state, challenge, loginHint, prompt = 'select_account' }) {
  const c = config();
  const u = new URL(`https://login.microsoftonline.com/${c.tenant}/oauth2/v2.0/authorize`);
  u.searchParams.set('client_id', c.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', c.redirectUri);
  u.searchParams.set('response_mode', 'query');
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (loginHint) u.searchParams.set('login_hint', loginHint);
  // Utan detta återanvänder Microsoft den inloggning som redan finns i
  // webbläsaren — vilket lätt blir ett administratörskonto utan brevlåda.
  if (prompt) u.searchParams.set('prompt', prompt);
  return u.toString();
}

async function tokenRequest(body) {
  const c = config();
  const res = await fetch(`https://login.microsoftonline.com/${c.tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`Entra svarade med fel: ${String(msg).split('\n')[0]}`);
  }
  return data;
}

function exchangeCode({ code, verifier }) {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config().redirectUri,
    code_verifier: verifier,
    scope: SCOPES.join(' '),
  });
}

function refresh(refreshToken) {
  return tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPES.join(' '),
  });
}

async function call(accessToken, path, { method = 'GET', body, prefer } = {}) {
  /*
   * Ingen tidszonsheader som standard. En global
   * `Prefer: outlook.timezone="Europe/Stockholm"` fick Graph att svara i lokal
   * tid medan koden tolkade svaret som UTC — upptagna tider hamnade två timmar
   * fel, så bokade tider visades som lediga. Den som behöver en viss tidszon
   * begär den uttryckligen och kontrollerar vad svaret faktiskt säger.
   */
  const res = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      ...(prefer ? { prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Graph svarade HTTP ${res.status}`);
    err.status = res.status;
    err.graphCode = data?.error?.code;
    throw err;
  }
  return data;
}

function me(accessToken) {
  return call(accessToken, '/me?$select=id,displayName,mail,userPrincipalName');
}

/**
 * Upptagen tid ur värdens egen kalender.
 * getSchedule ger bara ledig/upptagen — inga mötesrubriker lämnar M365,
 * vilket är avsiktligt: tjänsten behöver inte veta vad mötena handlar om.
 */
// Graph tillåter högst 62 dygn per fråga om ledig/upptaget. Längre fönster
// delas upp; en omröstning kan föreslå tider långt isär.
const MAX_DYGN_PER_FRAGA = 60;

async function busyIntervals(accessToken, { upn, fromIso, toIso }) {
  const start = new Date(fromIso);
  const slut = new Date(toIso);
  const langd = MAX_DYGN_PER_FRAGA * 86400_000;

  const alla = [];
  for (let fran = start; fran < slut; fran = new Date(fran.getTime() + langd)) {
    const till = new Date(Math.min(fran.getTime() + langd, slut.getTime()));
    const data = await call(accessToken, '/me/calendar/getSchedule', {
      method: 'POST',
      prefer: 'outlook.timezone="UTC"',
      body: {
        schedules: [upn],
        startTime: { dateTime: fran.toISOString().replace('Z', ''), timeZone: 'UTC' },
        endTime: { dateTime: till.toISOString().replace('Z', ''), timeZone: 'UTC' },
        availabilityViewInterval: 15,
      },
    });
    alla.push(...tolkaSchema(data?.value?.[0]?.scheduleItems || []));
  }

  // Delarna kan överlappa i kanterna; samma post ska inte räknas två gånger.
  const sedda = new Set();
  return alla.filter((b) => {
    const nyckel = `${b.start}|${b.end}`;
    if (sedda.has(nyckel)) return false;
    sedda.add(nyckel);
    return true;
  });
}

/** Statusar som ska blockera en tid. 'free' gör det inte — den är ledig med flit. */
const UPPTAGET = ['busy', 'oof', 'tentative', 'workingElsewhere'];

/**
 * Översätter Graphs schemaposter till UTC-intervall.
 *
 * Kastar hellre än gissar om svaret inte är i UTC: en felräknad tidszon visar
 * bokade tider som lediga, och då är det bättre att ledig/upptaget-läsningen
 * misslyckas synligt och loggas än att den tyst ger fel svar.
 */
function tolkaSchema(items) {
  return items
    .filter((i) => UPPTAGET.includes(i.status))
    .map((i) => {
      for (const punkt of [i.start, i.end]) {
        const zon = String(punkt?.timeZone || '').toUpperCase();
        if (zon && zon !== 'UTC') {
          throw new Error(
            `Graph svarade med tidszonen "${punkt.timeZone}" i stället för UTC. ` +
              'Tiderna kan inte tolkas säkert och ledig/upptaget hoppas över.'
          );
        }
      }
      return {
        start: `${i.start.dateTime.replace(' ', 'T').slice(0, 19)}Z`,
        end: `${i.end.dateTime.replace(' ', 'T').slice(0, 19)}Z`,
      };
    });
}

/** Skapar mötet i värdens kalender med bokaren som deltagare. M365 skickar inbjudan. */
async function createEvent(accessToken, ev) {
  const online = ev.locationType === 'teams';
  const body = {
    subject: ev.subject,
    body: { contentType: 'HTML', content: ev.bodyHtml },
    start: { dateTime: ev.startIso.replace('Z', ''), timeZone: 'UTC' },
    end: { dateTime: ev.endIso.replace('Z', ''), timeZone: 'UTC' },
    attendees: [
      { emailAddress: { address: ev.inviteeEmail, name: ev.inviteeName }, type: 'required' },
      // Medvärdar på en bokningstjänst med flera personer.
      ...(ev.extraAttendees || []).map((a) => ({
        emailAddress: { address: a.address, name: a.name },
        type: 'required',
      })),
    ],
    allowNewTimeProposals: false,
    isOnlineMeeting: online,
    ...(online ? { onlineMeetingProvider: 'teamsForBusiness' } : {}),
    ...(ev.locationText ? { location: { displayName: ev.locationText } } : {}),
    transactionId: ev.transactionId,
  };
  const created = await call(accessToken, '/me/events', { method: 'POST', body });
  return {
    id: created.id,
    // Outlooks eget kalender-id. Skickar vi senare en ICS med samma id hamnar
    // den på samma möte i mottagarens kalender i stället för som en dubblett.
    icalUid: created.iCalUId || null,
    joinUrl: created.onlineMeeting?.joinUrl || created.onlineMeetingUrl || null,
    webLink: created.webLink || null,
  };
}

/** Avbokar. cancel skickar återtagande till deltagaren; delete gör det inte. */
async function cancelEvent(accessToken, eventId, comment) {
  try {
    await call(accessToken, `/me/events/${encodeURIComponent(eventId)}/cancel`, {
      method: 'POST',
      body: { Comment: comment || 'Mötet är avbokat.' },
    });
  } catch (err) {
    // Redan borta i kalendern är inget fel att skrika om.
    if (err.status !== 404) throw err;
  }
}

/**
 * Preliminärbokning för ett förslag i en omröstning. Markeras som "preliminär"
 * (showAs: tentative) och har inga deltagare — ingen utomstående ska få en
 * inbjudan till en tid som kanske inte blir av. Syftet är att tiden syns som
 * bokad för kollegor och blockeras i tjänstens egen ledig/upptaget-läsning.
 */
async function createHold(accessToken, { subject, bodyHtml, startIso, endIso, transactionId }) {
  const created = await call(accessToken, '/me/events', {
    method: 'POST',
    body: {
      subject,
      body: { contentType: 'HTML', content: bodyHtml || '' },
      start: { dateTime: startIso.replace('Z', ''), timeZone: 'UTC' },
      end: { dateTime: endIso.replace('Z', ''), timeZone: 'UTC' },
      showAs: 'tentative',
      isReminderOn: false,
      categories: ['Boka tid — preliminär'],
      transactionId,
    },
  });
  return { id: created.id };
}

/**
 * Raderar en preliminärbokning. Hård radering, inte avbokning: händelsen har
 * inga deltagare, så det finns ingen att skicka återtagande till.
 */
async function deleteEvent(accessToken, eventId) {
  try {
    await call(accessToken, `/me/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
    return true;
  } catch (err) {
    if (err.status === 404) return true;
    throw err;
  }
}

/**
 * Har kontot en användbar kalender? Ett administratörskonto utan Exchange-licens
 * kan godkänna behörigheten men saknar brevlåda, och då misslyckas varje
 * kalenderanrop efteråt. Bättre att upptäcka det vid kopplingen än vid bokning.
 */
async function calendarUsable(accessToken) {
  try {
    await call(accessToken, '/me/calendar?$select=id,name');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message, graphCode: err.graphCode, status: err.status };
  }
}

module.exports = { SCOPES, isConfigured, calendarUsable, createHold, deleteEvent, tolkaSchema, config, authorizeUrl, exchangeCode, refresh, me, busyIntervals, createEvent, cancelEvent, call };
