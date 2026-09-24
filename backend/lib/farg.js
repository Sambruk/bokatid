'use strict';
// Färgtema med kontrastkrav.
//
// En organisations signaturfärg är vald för tryck och logotyper, inte för text
// på skärm. Sambruks egen gröna #58A618 ger bara 3,05:1 mot vitt och klarar
// alltså inte WCAG 2.1 AA (4,5:1 för text, 3:1 för gränser och ikoner). Därför
// tar tjänsten emot färgen som den är, men mörknar den till en textvariant som
// klarar kravet. Den ljusa originalfärgen används bara dekorativt.

const KRAV_TEXT = 4.5;

function parseHex(v) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v || '').trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

const tillHex = ({ r, g, b }) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/** Relativ luminans enligt WCAG. */
function luminans({ r, g, b }) {
  const kanal = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * kanal(r) + 0.7152 * kanal(g) + 0.0722 * kanal(b);
}

/** Kontrastkvot mellan två färger, 1–21. */
function kontrast(a, b) {
  const l1 = luminans(a);
  const l2 = luminans(b);
  const ljus = Math.max(l1, l2);
  const mork = Math.min(l1, l2);
  return (ljus + 0.05) / (mork + 0.05);
}

const VIT = { r: 255, g: 255, b: 255 };

/**
 * Mörknar färgen stegvis tills den klarar kravet mot vitt.
 * Kontrasten mäts på den AVRUNDADE färgen, alltså den som faktiskt hamnar i
 * CSS:en. Mäts den på mellanräkningen kan avrundningen knuffa slutresultatet
 * strax under kravet — 4,48 i stället för 4,5.
 */
function morknaTillKrav(farg, krav = KRAV_TEXT) {
  let aktuell = { ...farg };
  const avrunda = (f) => ({ r: Math.round(f.r), g: Math.round(f.g), b: Math.round(f.b) });
  for (let i = 0; i < 200 && kontrast(avrunda(aktuell), VIT) < krav; i++) {
    aktuell = { r: aktuell.r * 0.93, g: aktuell.g * 0.93, b: aktuell.b * 0.93 };
    if (aktuell.r < 1 && aktuell.g < 1 && aktuell.b < 1) return { r: 0, g: 0, b: 0 };
  }
  return avrunda(aktuell);
}

function morkare(farg, faktor = 0.8) {
  return { r: Math.round(farg.r * faktor), g: Math.round(farg.g * faktor), b: Math.round(farg.b * faktor) };
}

/**
 * Bygger ett tema ur en vald färg.
 * @returns {{vald, text, hover, dekor, kontrastVald, kontrastText, justerad}}
 */
function tema(valdHex) {
  const vald = parseHex(valdHex);
  if (!vald) return null;

  const kontrastVald = kontrast(vald, VIT);
  const text = kontrastVald >= KRAV_TEXT ? vald : morknaTillKrav(vald);

  return {
    vald: tillHex(vald),
    text: tillHex(text),
    hover: tillHex(morkare(text)),
    dekor: tillHex(vald),
    kontrastVald: Math.round(kontrastVald * 100) / 100,
    kontrastText: Math.round(kontrast(text, VIT) * 100) / 100,
    // Sant när färgen inte dög som textfärg och en mörkare variant används.
    justerad: tillHex(text) !== tillHex(vald),
  };
}

module.exports = { tema, kontrast, parseHex, tillHex, luminans, KRAV_TEXT };
