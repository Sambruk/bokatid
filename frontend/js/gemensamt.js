'use strict';
// Gemensamma hjälpfunktioner. Ingen byggkedja, inga ramverk.

/**
 * Basvägen räknas ut från adressen i stället för att konfigureras, så samma
 * filer fungerar både på /boka/... bakom nginx och på roten vid lokal körning.
 * @param {number} strip antal sista segment som hör till sidan, inte till basen
 */
function basvag(strip) {
  const delar = location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  const bas = delar.slice(0, Math.max(0, delar.length - strip));
  return bas.length ? '/' + bas.join('/') : '';
}

async function hamta(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fel ${res.status}`);
  return data;
}

async function skicka(url, body, metod = 'POST') {
  const res = await fetch(url, {
    method: metod,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'boka-tid' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fel ${res.status}`);
  return data;
}

function txt(el, s) {
  el.textContent = s == null ? '' : String(s);
}

/** Meddelanden läses upp av skärmläsare tack vare aria-live i markeringen. */
function notis(el, text, typ = 'info') {
  el.className = `notis notis--${typ}`;
  el.textContent = text;
  el.hidden = false;
}

function rensaNotis(el) {
  el.hidden = true;
  el.textContent = '';
}

function minuterTillKlocka(m) {
  const h = String(Math.floor(m / 60)).padStart(2, '0');
  return `${h}:${String(m % 60).padStart(2, '0')}`;
}

function klockaTillMinuter(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const minuter = Number(m[1]) * 60 + Number(m[2]);
  return minuter >= 0 && minuter <= 1440 ? minuter : null;
}

const VECKODAGAR = ['måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag', 'söndag'];

function visaIdag(el) {
  const idag = new Date().toLocaleDateString('sv-SE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  el.textContent = `I dag är det ${idag}`;
}

/**
 * Hämtar organisationen och målar upp den: logga, namn och länk i sidhuvudet,
 * samt färgtemat som CSS-variabler. Anropas av varje publik sida.
 *
 * Temats textfärg kommer från servern, som mörknat signaturfärgen om den inte
 * klarat 4,5:1 mot vitt. Originalfärgen används bara som dekor, aldrig till text.
 */
async function visaOrganisation(bas) {
  let org;
  try {
    org = await hamta(`${bas}/api/organization`);
  } catch (err) {
    // Sidan fungerar utan organisationsuppgifter, men felet ska inte vara tyst:
    // annars ser en försvunnen logga ut som en gåta i stället för ett fel.
    console.warn('Kunde inte hämta organisationsuppgifter:', err.message);
    return null;
  }

  if (org.tema) {
    const rot = document.documentElement.style;
    rot.setProperty('--gron', org.tema.text);
    rot.setProperty('--gron-mork', org.tema.hover);
    rot.setProperty('--gron-ljus', org.tema.dekor);
  }

  const namnEl = document.getElementById('orgNamn');
  const lankEl = document.getElementById('orgLank');
  if (!namnEl || !lankEl) return org;

  // Namnet lämnas tomt om organisationen inte satt något: "Boka tid" står som
  // egen rad i sidhuvudet och ska inte dubbleras här.
  namnEl.textContent = org.name || '';

  // Loggan skapas här i stället för att ligga dold i HTML:en. Ett element som
  // inte finns kan inte glömmas bort synligt eller osynligt av en stilregel.
  if (org.logoUrl) {
    const bild = document.createElement('img');
    bild.className = 'topp__logga';
    bild.src = `${bas}/${org.logoUrl}`;
    // Har organisationen både logga och namn är loggan dekorativ: namnet står
    // redan som text, och en upprepning stör den som lyssnar på sidan.
    bild.alt = org.name ? '' : 'Organisationens logotyp';
    lankEl.append(bild);
  }

  /*
   * Ett sidhuvud, en länk till webbplatsen. Finns en logga bär den länken,
   * annars namnet. Två länkar till samma mål blir bara brus i en skärmläsare.
   */
  if (org.websiteUrl) {
    if (org.logoUrl) {
      // Loggan blir länk genom att bytas till ett a-element med samma innehåll.
      const lank = document.createElement('a');
      lank.className = lankEl.className;
      lank.href = org.websiteUrl;
      // Namnet sätts med aria-label, inte bara title: title läses upp
      // inkonsekvent och syns inte alls på pekskärm.
      lank.setAttribute('aria-label', `Till ${org.name || 'organisationens webbplats'}`);
      lank.title = `Till ${org.name || 'organisationens webbplats'}`;
      while (lankEl.firstChild) lank.append(lankEl.firstChild);
      lankEl.replaceWith(lank);
    } else if (org.name) {
      const lank = document.createElement('a');
      lank.href = org.websiteUrl;
      lank.textContent = org.name;
      lank.title = `Till ${org.name}`;
      namnEl.textContent = '';
      namnEl.append(lank);
    }
  }
  return org;
}
