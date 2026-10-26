'use strict';
// MCP-endpoint för AI-agenter (Streamable HTTP, tillståndslös).
//
// Varje anrop får en egen MCP-server, så inget tillstånd lever mellan anropen och
// en omstart av tjänsten bryter inga agentsessioner. Verktygen anropar tjänstens
// eget REST-API över loopback med agentens nyckel, så samma kontroller gäller som
// för webbsidan: slotmotorn, dubbelbokningsspärren, kalenderskrivningen, mailen.
//
// Agenten ser bara de verktyg som nyckelns behörigheter tillåter.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { audit } = require('./db');

const INSTRUKTIONER = `Boka tid: mötesbokning och omröstningar om mötestid.

Boka en fast tid:
1. lista_tjanster — vilka tjänster som går att boka och hos vem (vard + tjanst).
2. lediga_tider — lediga starttider för en tjänst, plus frågorna som måste besvaras.
3. boka — boka en av starttiderna exakt som den returnerades (ISO-tid i UTC).
Bekräfta alltid tid, namn och e-post med användaren innan du bokar: bokningen skickar
en inbjudan till den e-postadressen.

Samla deltagare med en omröstning (nyckelägaren är värd):
1. omrostning_tider — lediga starttider i värdens kalender för önskad längd.
2. skapa_omrostning med forhandsgranska: true — visa sammanställningen för användaren
   och få rubrik, tider och mottagare bekräftade. Inget sparas, inget mejlas.
3. skapa_omrostning igen utan forhandsgranska, med en klient_referens. Inbjudningarna
   mejlas och tiderna reserveras preliminärt i värdens kalender i bakgrunden.
4. visa_omrostning — följ svaren (och att reservationerna blev klara).
5. besluta_tid med ett tid_id från visa_omrostning, eller avbryt_omrostning.
Ta bort omröstningar gör användaren själv i adminvyn.

Tider visas för människor i svensk tid (klockan/nar); skicka alltid start exakt som den
returnerades.`;

/**
 * Behörigheterna varje verktyg kräver; någon av dem räcker. Samma tabell styr
 * vilka verktyg agenten ser och testas i test/mcp.test.js.
 */
const KRAV = {
  lista_tjanster: ['las', 'boka'],
  lediga_tider: ['las', 'boka'],
  boka: ['boka'],
  mina_bokningar: ['las'],
  avboka: ['avboka'],
  omrostning_tider: ['las', 'omrostning'],
  mina_omrostningar: ['las', 'omrostning'],
  visa_omrostning: ['las', 'omrostning'],
  skapa_omrostning: ['omrostning'],
  lagg_till_deltagare: ['omrostning'],
  paminn: ['omrostning'],
  besluta_tid: ['omrostning'],
  avbryt_omrostning: ['omrostning'],
};

const far = (scopes, verktyg) => KRAV[verktyg].some((k) => scopes.includes(k));

/** Verktygen en nyckel med de här behörigheterna ser. */
const verktygFor = (scopes) => Object.keys(KRAV).filter((v) => far(scopes, v)).sort();

const DATUM = /^\d{4}-\d{2}-\d{2}$/;
const STATUS_SV = { open: 'öppen', closed: 'stängd', decided: 'beslutad', cancelled: 'avbruten' };
const SVAR_SV = { ja: 'ja', kanske: 'kanske', nej: 'nej' };

function mcpRoutes({ router, port }) {
  const bas = `http://127.0.0.1:${port}`;

  /** Anropar tjänstens eget API med agentens nyckel. Kastar med API:ts felmeddelande. */
  async function anrop(req, vag, { method = 'GET', body } = {}) {
    const res = await fetch(bas + vag, {
      method,
      headers: {
        authorization: req.get('authorization'),
        'content-type': 'application/json',
        // Loopback: behåll agentens verkliga adress i granskningen.
        'x-forwarded-for': req.ip || '',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Fel ${res.status}`);
    return data;
  }

  const svar = (data) => ({
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  });
  const fel = (err) => ({ content: [{ type: 'text', text: err.message }], isError: true });
  const seg = (s) => encodeURIComponent(String(s));

  function byggServer(req) {
    const { scopes, user, tokenId, tokenName } = req.agent;
    const har = (verktyg) => far(scopes, verktyg);
    const logga = (verktyg, detalj = {}) =>
      audit(`agent:${user.email}`, 'agent_anrop', { verktyg, nyckel: tokenId, namn: tokenName, ...detalj });

    const server = new McpServer(
      { name: 'boka-tid', version: '1.0.0' },
      { instructions: INSTRUKTIONER }
    );

    if (har('lista_tjanster')) {
      server.registerTool(
        'lista_tjanster',
        {
          title: 'Lista bokningsbara tjänster',
          description: 'Alla tjänster som går att boka, grupperade per person, plus gemensamma tjänster med flera värdar. Ger vard och tjanst som de andra verktygen behöver.',
          inputSchema: {},
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
          try {
            const d = await anrop(req, '/api/oversikt');
            const tjanst = (e) => ({
              vard: e.hostSlug,
              tjanst: e.slug,
              titel: e.title,
              beskrivning: e.description || undefined,
              minuter: e.duration_min,
              plats: e.location_type,
            });
            return svar({
              idag: d.today,
              personer: d.personer.map((p) => ({ namn: p.name, titel: p.title || undefined, tjanster: p.eventTypes.map(tjanst) })),
              gemensamma: (d.grupp || []).map((g) => ({ ...tjanst(g), vardar: (g.hosts || []).map((h) => h.name) })),
            });
          } catch (err) {
            return fel(err);
          }
        }
      );
    }

    if (har('lediga_tider')) {
      server.registerTool(
        'lediga_tider',
        {
          title: 'Lediga tider för en tjänst',
          description: 'Lediga starttider för en tjänst, dag för dag (högst 31 dagar per anrop). Visar också frågorna som måste besvaras vid bokning. Starttiden i "start" är den som ska skickas till boka.',
          inputSchema: {
            vard: z.string().describe('Värdens kortnamn, t.ex. "thomas" (fältet vard i lista_tjanster)'),
            tjanst: z.string().describe('Tjänstens kortnamn (fältet tjanst i lista_tjanster)'),
            fran: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Första dag, ÅÅÅÅ-MM-DD. Standard: idag'),
            till: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Sista dag, ÅÅÅÅ-MM-DD. Standard: två veckor fram'),
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ vard, tjanst, fran, till }) => {
          try {
            const typ = await anrop(req, `/api/event-type/${seg(vard)}/${seg(tjanst)}`);
            const qs = new URLSearchParams();
            if (fran) qs.set('from', fran);
            if (till) qs.set('to', till);
            const d = await anrop(req, `/api/slots/${seg(vard)}/${seg(tjanst)}?${qs}`);
            const e = typ.eventType;
            return svar({
              tjanst: {
                titel: e.title,
                minuter: e.duration_min,
                plats: e.location_type === 'physical' ? e.location_text : e.location_type,
                vardar: typ.hosts.map((h) => h.name),
                fragor: (e.questions || []).map((f) => ({ nyckel: f.key, obligatorisk: !!f.required })),
                bokasSenast: d.maxDate,
              },
              tidszon: d.timezone,
              kalenderKontrollerad: d.calendarChecked,
              dagar: d.days.map((dag) => ({
                datum: dag.date,
                dag: dag.label,
                tider: dag.slots.map((s) => ({ start: s.start, klockan: s.label })),
              })),
            });
          } catch (err) {
            return fel(err);
          }
        }
      );
    }

    if (har('boka')) {
      server.registerTool(
        'boka',
        {
          title: 'Boka en tid',
          description: 'Bokar en tid åt en person. Personen får en kalenderinbjudan och en avbokningslänk via e-post. Bekräfta tid, namn och e-post med användaren först. Svarar med fel om tiden hunnit bli upptagen — hämta då lediga_tider igen.',
          inputSchema: {
            vard: z.string(),
            tjanst: z.string(),
            start: z.string().describe('Starttiden exakt som i lediga_tider (ISO 8601 i UTC)'),
            namn: z.string().min(2).max(120).describe('Namn på den som ska delta i mötet'),
            epost: z.string().email().describe('E-post dit inbjudan skickas'),
            organisation: z.string().max(160).optional(),
            svar: z.record(z.string(), z.string()).optional().describe('Svar på tjänstens frågor, nyckel → svar'),
          },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async ({ vard, tjanst, start, namn, epost, organisation, svar: svarPaFragor }) => {
          try {
            const d = await anrop(req, `/api/book/${seg(vard)}/${seg(tjanst)}`, {
              method: 'POST',
              body: { start, name: namn, email: epost, org: organisation, answers: svarPaFragor || {} },
            });
            await logga('boka', { vard, tjanst, start });
            return svar({
              bokad: true,
              nar: d.booking?.when,
              teamsLank: d.booking?.joinUrl || undefined,
              inbjudanSkickadTill: epost,
            });
          } catch (err) {
            return fel(err);
          }
        }
      );
    }

    if (har('mina_bokningar')) {
      server.registerTool(
        'mina_bokningar',
        {
          title: 'Mina bokningar',
          description: `Bokningar hos ${user.name} (nyckelns ägare). Kommande som standard.`,
          inputSchema: {
            tidigare: z.boolean().optional().describe('true = passerade bokningar i stället för kommande'),
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ tidigare }) => {
          try {
            const d = await anrop(req, `/api/admin/bookings?scope=${tidigare ? 'past' : 'upcoming'}`);
            return svar({
              bokningar: d.bookings.map((b) => ({
                id: b.id,
                nar: b.when,
                start: b.start_utc,
                tjanst: b.title,
                namn: b.invitee_name,
                epost: b.invitee_email,
                organisation: b.invitee_org || undefined,
                svar: Object.keys(b.answers || {}).length ? b.answers : undefined,
                status: b.status === 'cancelled' ? 'avbokad' : 'bekräftad',
                teamsLank: b.join_url || undefined,
              })),
            });
          } catch (err) {
            return fel(err);
          }
        }
      );
    }

    if (har('avboka')) {
      server.registerTool(
        'avboka',
        {
          title: 'Avboka en bokning',
          description: `Avbokar en av ${user.name}s bokningar (id från mina_bokningar). Mötet tas bort ur kalendern och den som bokat får ett mail. Går inte att ångra — bekräfta med användaren först.`,
          inputSchema: {
            id: z.number().int().positive(),
            orsak: z.string().max(500).optional().describe('Skickas med i avbokningsmailet'),
          },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        },
        async ({ id, orsak }) => {
          try {
            const d = await anrop(req, `/api/admin/bookings/${id}/cancel`, { method: 'POST', body: { reason: orsak } });
            await logga('avboka', { bokning: id });
            return svar({ avbokad: true, redanAvbokad: !!d.alreadyCancelled });
          } catch (err) {
            return fel(err);
          }
        }
      );
    }

    /* ---------- omröstningar om mötestid ---------- */

    const omrostningKort = (p) => ({
      id: p.id,
      rubrik: p.title,
      status: STATUS_SV[p.status] || p.status,
      sista_svarsdag: p.deadline || undefined,
      tider: Number(p.antal_tider),
      inbjudna: Number(p.antal_deltagare),
      svarande: Number(p.antal_svar),
      lank: p.url,
    });

    if (har('omrostning_tider')) {
      server.registerTool(
        'omrostning_tider',
        {
          title: 'Lediga tider för en omröstning',
          description: `Lediga starttider i ${user.name}s kalender (nyckelns ägare) för ett möte av given längd, med veckoschema, bokningar, andra omröstningar och kalendern inräknade. Starttiden i "start" är den som ska skickas till skapa_omrostning.`,
          inputSchema: {
            langd_min: z.number().int().min(5).max(480).describe('Mötets längd i minuter'),
            fran: z.string().regex(DATUM).optional().describe('Första dag, ÅÅÅÅ-MM-DD. Standard: idag'),
            till: z.string().regex(DATUM).optional().describe('Sista dag, ÅÅÅÅ-MM-DD (högst 60 dagar efter fran). Standard: tre veckor fram'),
            steg_min: z.number().int().min(5).max(240).optional().describe('Hur tätt starttiderna ligger. Standard 30'),
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ langd_min, fran, till, steg_min }) => {
          try {
            const qs = new URLSearchParams({ duration: String(langd_min) });
            if (fran) qs.set('from', fran);
            if (till) qs.set('to', till);
            if (steg_min) qs.set('step', String(steg_min));
            const d = await anrop(req, `/api/admin/poll-slots?${qs}`);
            return svar({
              vard: user.name,
              kalenderKontrollerad: d.calendarChecked,
              dagar: d.days.map((dag) => ({
                datum: dag.date,
                dag: dag.label,
                tider: dag.slots.map((t) => ({ start: t.start, klockan: t.label })),
              })),
            });
          } catch (err) {
            return fel(err);
          }
        }
      );
    }

    if (har('mina_omrostningar')) {
      server.registerTool(
        'mina_omrostningar',
        {
          title: 'Mina omröstningar',
          description: `Omröstningar om mötestid som ${user.name} (nyckelns ägare) har skapat, nyast först.`,
          inputSchema: {
            status: z.enum(['open', 'decided', 'closed', 'cancelled']).optional().describe('Bara omröstningar med den här statusen'),
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ status }) => {
          try {
            const d = await anrop(req, '/api/admin/polls');
            const egna = d.polls.filter((p) => p.egen !== false && (!status || p.status === status));
            return svar({ omrostningar: egna.map(omrostningKort) });
          } catch (err) {
            return fel(err);
          }
        }
      );
    }

    if (har('visa_omrostning')) {
      server.registerTool(
        'visa_omrostning',
        {
          title: 'Visa en omröstning',
          description: 'Tiderna med antal ja/kanske/nej, vem som svarat och inte, deltagarnas svar per tid och om preliminärbokningen finns i kalendern. tider[].id är det tid_id som besluta_tid vill ha.',
          inputSchema: { id: z.number().int().positive().describe('Omröstningens id') },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ id }) => {
          try {
            const d = await anrop(req, `/api/admin/polls/${id}`);
            const p = d.poll;
            return svar({
              id: p.id,
              rubrik: p.title,
              beskrivning: p.description || undefined,
              status: STATUS_SV[p.status] || p.status,
              lank: p.url,
              langd_min: p.duration_min,
              plats: p.location_type === 'physical' ? p.location_text : p.location_type,
              sista_svarsdag: p.deadline || undefined,
              // Reservationer och inbjudningar görs i bakgrunden efter skapandet.
              pagar: p.bakgrund || undefined,
              beslutad_tid: p.decided_option || undefined,
              teamsLank: p.decided_join || undefined,
              tider: d.options.map((o) => ({
                id: o.id,
                nar: o.when,
                start: o.start,
                ja: o.rakning.ja,
                kanske: o.rakning.kanske,
                nej: o.rakning.nej,
                reserverad_i_kalendern: p.hold_calendar ? o.holdOk : undefined,
                reservationsfel: o.holdError || undefined,
              })),
              deltagare: d.participants.map((x) => ({
                namn: x.name,
                epost: x.email,
                organisation: x.org || undefined,
                inbjuden: x.invited,
                svarat: x.responded,
                tillagd_av_deltagare: x.tillagdAv || undefined,
                svar: Object.fromEntries(Object.entries(x.svar).map(([tid, s]) => [tid, SVAR_SV[s] || s])),
              })),
              ej_svarat: d.participants.filter((x) => !x.responded).map((x) => x.name),
            });
          } catch (err) {
            return fel(err);
          }
        }
      );
    }

    if (har('skapa_omrostning')) {
      server.registerTool(
        'skapa_omrostning',
        {
          title: 'Skapa en omröstning om mötestid',
          description: `Skapar en omröstning med ${user.name} som värd. Varje deltagare får en inbjudan via e-post med en personlig svarslänk, och tiderna reserveras preliminärt i värdens kalender. Kör först med forhandsgranska: true och visa sammanställningen för användaren. Tiderna måste komma från omrostning_tider; en upptagen tid ger fel och ingenting sparas.`,
          inputSchema: {
            rubrik: z.string().min(2).max(160),
            beskrivning: z.string().max(2000).optional(),
            langd_min: z.number().int().min(5).max(480),
            tider: z.array(z.string()).min(1).max(20).describe('Starttider exakt som i omrostning_tider (ISO 8601 i UTC)'),
            deltagare: z
              .array(z.object({ namn: z.string().min(1).max(120), epost: z.string().email(), organisation: z.string().max(160).optional() }))
              .max(50)
              .optional()
              .describe('De som bjuds in. Utelämnas listan skapas omröstningen utan utskick och länken kan delas manuellt.'),
            sista_svarsdag: z.string().regex(DATUM).optional().describe('ÅÅÅÅ-MM-DD'),
            plats: z.enum(['teams', 'phone', 'physical', 'other']).optional().describe('Standard teams'),
            plats_text: z.string().max(300).optional().describe('Adress eller annan platsuppgift'),
            reservera_kalender: z.boolean().optional().describe('Reservera tiderna preliminärt i värdens kalender. Standard true'),
            dolj_namn: z.boolean().optional().describe('Dölj deltagarnas namn för varandra på svarssidan'),
            forhandsgranska: z.boolean().optional().describe('true = kontrollera och visa vad som skulle hända, utan att spara eller mejla'),
            klient_referens: z.string().max(100).optional().describe('Valfri egen referens. Samma referens igen ger den omröstning som redan skapats, utan nya utskick'),
          },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async (a) => {
          try {
            const d = await anrop(req, '/api/admin/polls', {
              method: 'POST',
              body: {
                title: a.rubrik,
                description: a.beskrivning,
                duration_min: a.langd_min,
                options: a.tider,
                participants: (a.deltagare || []).map((x) => ({ name: x.namn, email: x.epost, org: x.organisation })),
                deadline: a.sista_svarsdag,
                location_type: a.plats || 'teams',
                location_text: a.plats_text,
                hold_calendar: a.reservera_kalender !== false,
                hide_names: a.dolj_namn === true,
                dry_run: a.forhandsgranska === true,
                client_ref: a.klient_referens,
              },
            });
            if (d.forhandsgranskning) {
              return svar({ ...d, obs: 'Inget är sparat eller skickat. Bekräfta med användaren och anropa igen utan forhandsgranska.' });
            }
            await logga('skapa_omrostning', { omrostning: d.poll.id, redanSkapad: !!d.redanSkapad });
            if (d.redanSkapad) {
              return svar({ skapad: false, redanSkapad: true, id: d.poll.id, lank: d.poll.url, obs: 'Omröstningen med den klient_referensen fanns redan. Inget nytt skickades.' });
            }
            return svar({
              skapad: true,
              id: d.poll.id,
              lank: d.poll.url,
              pagar: {
                reservationer_i_kalendern: d.bakgrund?.reservationer || 0,
                inbjudningar: d.bakgrund?.inbjudningar || 0,
              },
              obs: 'Reservationer och inbjudningar görs i bakgrunden och är normalt klara inom några sekunder. Följ upp med visa_omrostning.',
            });
          } catch (err) {
            return fel(err);
          }
        }
      );
    }

    if (har('lagg_till_deltagare')) {
      server.registerTool(
        'lagg_till_deltagare',
        {
          title: 'Bjud in fler till en omröstning',
          description: 'Lägger till en deltagare i en öppen omröstning och mejlar inbjudan direkt. Bekräfta namn och e-post med användaren först.',
          inputSchema: {
            id: z.number().int().positive().describe('Omröstningens id'),
            namn: z.string().min(1).max(120),
            epost: z.string().email(),
            organisation: z.string().max(160).optional(),
          },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async ({ id, namn, epost, organisation }) => {
          try {
            const d = await anrop(req, `/api/admin/polls/${id}/participants`, {
              method: 'POST',
              body: { name: namn, email: epost, org: organisation },
            });
            await logga('lagg_till_deltagare', { omrostning: id });
            return svar({ tillagd: true, inbjudanSkickad: !!d.mailAccepted });
          } catch (err) {
            return fel(err);
          }
        }
      );
    }

    if (har('paminn')) {
      server.registerTool(
        'paminn',
        {
          title: 'Påminn dem som inte svarat',
          description: 'Mejlar inbjudan på nytt till deltagare som ännu inte svarat i en öppen omröstning. En agent får påminna högst en gång per omröstning och tolv timmar.',
          inputSchema: { id: z.number().int().positive().describe('Omröstningens id') },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async ({ id }) => {
          try {
            const d = await anrop(req, `/api/admin/polls/${id}/remind`, { method: 'POST', body: {} });
            await logga('paminn', { omrostning: id });
            return svar({ paminda: d.skickade, utanSvar: d.utanSvar });
          } catch (err) {
            return fel(err);
          }
        }
      );
    }

    if (har('besluta_tid')) {
      server.registerTool(
        'besluta_tid',
        {
          title: 'Besluta tid',
          description: 'Beslutar en av omröstningens tider: mötet skapas i värdens kalender (med Teams-länk om platsen är Teams), deltagarna bjuds in och övriga preliminärbokningar släpps. Går inte att ångra — bekräfta tiden med användaren först.',
          inputSchema: {
            id: z.number().int().positive().describe('Omröstningens id'),
            tid_id: z.number().int().positive().describe('tider[].id från visa_omrostning'),
            bjud_in: z.enum(['alla', 'svarande']).optional().describe('alla (standard) = alla inbjudna, svarande = bara de som svarat'),
          },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        },
        async ({ id, tid_id, bjud_in }) => {
          try {
            const d = await anrop(req, `/api/admin/polls/${id}/decide`, {
              method: 'POST',
              body: { optionId: tid_id, invite: bjud_in === 'svarande' ? 'svarande' : 'alla' },
            });
            await logga('besluta_tid', { omrostning: id, tid: tid_id });
            return svar({
              beslutad: true,
              nar: d.when,
              teamsLank: d.joinUrl || undefined,
              motetIKalendern: !!d.calendarWritten,
              inbjudanViaOutlook: !!d.beskedViaOutlook,
              deltagare: d.antalDeltagare,
              slapptaReservationer: d.releasedHolds,
            });
          } catch (err) {
            return fel(err);
          }
        }
      );
    }

    if (har('avbryt_omrostning')) {
      server.registerTool(
        'avbryt_omrostning',
        {
          title: 'Avbryt en omröstning',
          description: 'Avbryter en omröstning som inte är beslutad: reservationerna släpps och de inbjudna får ett besked. Omröstningen finns kvar i historiken. Bekräfta med användaren först.',
          inputSchema: {
            id: z.number().int().positive().describe('Omröstningens id'),
            orsak: z.string().max(500).optional().describe('Skickas med i beskedet till deltagarna'),
          },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        },
        async ({ id, orsak }) => {
          try {
            const d = await anrop(req, `/api/admin/polls/${id}/cancel`, { method: 'POST', body: { reason: orsak } });
            await logga('avbryt_omrostning', { omrostning: id });
            return svar({
              avbruten: true,
              redanAvbruten: !!d.alreadyCancelled,
              slapptaReservationer: d.releasedHolds,
              deltagareMeddelade: d.mailAccepted,
            });
          } catch (err) {
            return fel(err);
          }
        }
      );
    }

    return server;
  }

  router.post('/mcp', async (req, res) => {
    if (!req.agent) {
      res.set('WWW-Authenticate', 'Bearer realm="boka-tid"');
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Kräver en agentnyckel: Authorization: Bearer bt_… (skapas i adminvyn under Konto)' },
        id: null,
      });
    }
    const server = byggServer(req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('mcp:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internt fel' }, id: null });
      }
    }
  });

  // Tillståndslöst: inga sessioner att öppna en ström mot eller avsluta.
  const ejTillatet = (req, res) =>
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Använd POST' }, id: null });
  router.get('/mcp', ejTillatet);
  router.delete('/mcp', ejTillatet);
}

module.exports = mcpRoutes;
module.exports.KRAV = KRAV;
module.exports.verktygFor = verktygFor;
