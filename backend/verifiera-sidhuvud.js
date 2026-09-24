'use strict';
// Kontrollerar att sidhuvudet byggs rätt: loggan, organisationens namn, länken
// och färgtemat. Körs mot en minimal DOM med samma flyttsemantik som en
// webbläsare, och mot det riktiga API-svaret — det är närmaste vi kommer en
// webbläsare på den här servern.
//
//   docker compose exec -T boka-tid-app node verifiera-sidhuvud.js

const fs = require('fs');
const vm = require('vm');

function skapaElement(tag) {
  return {
    tag, barn: [], attr: {}, className: '', _text: '', style: {}, foralder: null,
    set textContent(v) { this._text = v; this.barn = []; },
    get textContent() { return this._text; },
    get firstChild() { return this.barn.length ? this.barn[0] : null; },
    // Som i en riktig DOM: ett element som läggs till någon annanstans FLYTTAS dit.
    append(...b) {
      for (const x of b) {
        if (x.foralder) x.foralder.barn = x.foralder.barn.filter((y) => y !== x);
        x.foralder = this;
        this.barn.push(x);
      }
    },
    replaceWith(ny) { this.ersattAv = ny; },
    set src(v) { this.attr.src = v; }, get src() { return this.attr.src; },
    set alt(v) { this.attr.alt = v; }, get alt() { return this.attr.alt; },
    set href(v) { this.attr.href = v; }, get href() { return this.attr.href; },
    set title(v) { this.attr.title = v; }, get title() { return this.attr.title; },
  };
}
const element = { orgNamn: skapaElement('p'), orgLank: skapaElement('span'), idag: skapaElement('p') };
global.document = {
  documentElement: { style: { varden: {}, setProperty(k, v) { this.varden[k] = v; } } },
  getElementById: (id) => element[id] || null,
  createElement: skapaElement,
};
global.location = { pathname: '/boka/' };
const riktigFetch = global.fetch;
global.fetch = (u, o) => riktigFetch(String(u).startsWith('/') ? `http://127.0.0.1:3000${u}` : u, o);

vm.runInThisContext(fs.readFileSync('/app/public/js/gemensamt.js', 'utf8'), { filename: 'gemensamt.js' });

(async () => {
  const org = await visaOrganisation('/boka');
  if (!org) { console.log('FEL: inget svar från API:t'); process.exit(1); }
  const lank = element.orgLank.ersattAv || element.orgLank;
  const bild = lank.barn.find((b) => b.tag === 'img');
  const namnLank = element.orgNamn.barn.find((b) => b.tag === 'a');

  console.log('API gav        :', JSON.stringify({ namn: org.name, logga: org.logoUrl, webb: org.websiteUrl }));
  console.log('Loggan         :', bild ? `<img src="${bild.src}" alt="${bild.alt === '' ? '(tom, dekorativ)' : bild.alt}">` : 'SAKNAS');
  console.log('Loggan som länk:', lank.tag === 'a' ? `ja → ${lank.href}` : 'nej');
  console.log('Namnet         :', namnLank ? `<a>${namnLank.textContent}</a>` : `"${element.orgNamn.textContent}"`);
  console.log('Färgtema       :', JSON.stringify(document.documentElement.style.varden));

  const ok = Boolean(bild) && lank.tag === 'a' && element.orgNamn.textContent === org.name;
  console.log(ok ? '\nRESULTAT: logga och namn byggs som de ska.' : '\nRESULTAT: något saknas.');
  process.exit(ok ? 0 : 1);
})();
