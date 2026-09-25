'use strict';
// Prenumeration på en kalenderlänk (ICS).
//
// Så här delar en extern part sina upptagna tider utan att tjänsten någonsin kan
// skriva i deras kalender: de publicerar en läsbar ICS-adress ur Outlook, Google
// eller Nextcloud, och vi hämtar den. Läsning är allt som är möjligt.
//
// Två saker avgör om det här blir rätt eller farligt:
//  1. Återkommande möten måste vecklas ut. Missas de visas bokade tider som lediga.
//  2. Adressen kommer utifrån och pekar dit någon vill. Den får inte kunna användas
//     för att nå tjänster på det inre nätet.

const dns = require('dns').promises;
const net = require('net');
const ICAL = require('ical.js');

const MAX_BYTES = 4_000_000;
const TIMEOUT_MS = 15_000;
const MAX_OMDIRIGERINGAR = 3;

/** Privata, lokala och länklokala adresser — dit får hämtningen aldrig gå. */
function privatAdress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // inkl. molnens metadatatjänst
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
  if (v6.startsWith('::ffff:')) return privatAdress(v6.slice(7));
  return false;
}

async function kontrolleraAdress(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('Adressen är inte en giltig webbadress');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('Adressen måste börja med https://');
  }
  // webcal:// är vanligt i kalenderprogram men är bara https i förklädnad.
  const vardar = net.isIP(u.hostname) ? [u.hostname] : (await dns.lookup(u.hostname, { all: true })).map((a) => a.address);
  if (!vardar.length) throw new Error('Servernamnet går inte att slå upp');
  for (const ip of vardar) {
    if (privatAdress(ip)) throw new Error('Adressen pekar på ett internt nät och kan inte användas');
  }
  return u;
}

/** Hämtar ICS-innehållet, med egen hantering av omdirigeringar så varje hopp kontrolleras. */
async function hamtaIcs(url) {
  let aktuell = String(url).replace(/^webcal:\/\//i, 'https://');

  for (let hopp = 0; hopp <= MAX_OMDIRIGERINGAR; hopp++) {
    const u = await kontrolleraAdress(aktuell);
    const svar = await fetch(u, {
      redirect: 'manual',
      headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5', 'user-agent': 'Boka tid (kalenderprenumeration)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if ([301, 302, 303, 307, 308].includes(svar.status)) {
      const nasta = svar.headers.get('location');
      if (!nasta) throw new Error(`Servern svarade ${svar.status} utan att säga vart`);
      aktuell = new URL(nasta, u).toString();
      continue;
    }
    if (!svar.ok) throw new Error(`Servern svarade ${svar.status}`);

    const langd = Number(svar.headers.get('content-length') || 0);
    if (langd > MAX_BYTES) throw new Error(`Kalendern är för stor (${Math.round(langd / 1024)} kB)`);

    const text = await svar.text();
    if (text.length > MAX_BYTES) throw new Error('Kalendern är för stor');
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('Adressen svarar inte med en kalender (ingen VCALENDAR)');
    return text;
  }
  throw new Error('För många omdirigeringar');
}

/**
 * Tolkar ICS och returnerar upptagna tider i ett fönster.
 * Återkommande möten vecklas ut; undantag (EXDATE) och ändrade enstaka
 * förekomster hanteras av ical.js.
 */
function tolkaIcs(text, { fromIso, toIso }) {
  const from = new Date(fromIso);
  const to = new Date(toIso);

  /*
   * Standarden kräver CRLF, men alla servrar följer den inte — en kalender med
   * enbart LF avvisas av tolken med "component began but did not end", vilket
   * inte säger någon någonting. Normalisera i stället för att neka.
   */
  const normaliserad = text.replace(/\r\n|\r|\n/g, '\r\n');
  const comp = new ICAL.Component(ICAL.parse(normaliserad));
  const upptaget = [];

  for (const vevent of comp.getAllSubcomponents('vevent')) {
    const handelse = new ICAL.Event(vevent);

    // Tider som är markerade som lediga blockerar ingenting: den som satt
    // "ledig" i sin kalender menar att tiden går att boka.
    const transp = String(vevent.getFirstPropertyValue('transp') || '').toUpperCase();
    const status = String(vevent.getFirstPropertyValue('status') || '').toUpperCase();
    const msStatus = String(vevent.getFirstPropertyValue('x-microsoft-cdo-busystatus') || '').toUpperCase();
    if (transp === 'TRANSPARENT' || status === 'CANCELLED' || msStatus === 'FREE') continue;

    const lagg = (start, slut) => {
      const s = start.toJSDate();
      const e = slut ? slut.toJSDate() : new Date(s.getTime() + 30 * 60_000);
      if (e > from && s < to) upptaget.push({ start: s.toISOString(), end: e.toISOString() });
    };

    if (!handelse.isRecurring()) {
      lagg(handelse.startDate, handelse.endDate);
      continue;
    }

    // Utveckla serien inom fönstret. Taket hindrar att en serie utan slut
    // (FREQ=MINUTELY och liknande) låser tjänsten.
    const it = handelse.iterator();
    let nasta;
    let varv = 0;
    while ((nasta = it.next()) && varv++ < 2000) {
      const start = nasta.toJSDate();
      if (start > to) break;
      const detalj = handelse.getOccurrenceDetails(nasta);
      if (detalj.endDate.toJSDate() > from) {
        lagg(detalj.startDate, detalj.endDate);
      }
    }
  }

  // Slå ihop överlappande poster: färre intervall att jämföra mot per tid.
  upptaget.sort((a, b) => a.start.localeCompare(b.start));
  const ihop = [];
  for (const post of upptaget) {
    const forra = ihop[ihop.length - 1];
    if (forra && post.start <= forra.end) {
      if (post.end > forra.end) forra.end = post.end;
    } else {
      ihop.push({ ...post });
    }
  }
  return ihop;
}

/** Hämtar och tolkar i ett steg. */
async function hamtaUpptaget(url, { fromIso, toIso }) {
  const text = await hamtaIcs(url);
  return tolkaIcs(text, { fromIso, toIso });
}

module.exports = { hamtaIcs, tolkaIcs, hamtaUpptaget, privatAdress, kontrolleraAdress };
