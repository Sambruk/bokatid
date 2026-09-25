# Tillgänglighetsgranskning av de publika sidorna

Granskad 25 september 2026 mot **WCAG 2.1 AA**, som är kravnivån i lagen om
tillgänglighet till digital offentlig service.

## Så gick granskningen till

Sidorna renderades i Chromium med det JavaScript som bygger innehållet, och
granskades med axe-core 4 på taggarna `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`
och `best-practice`. Utöver det kördes egna kontroller som ett stillastående
svep inte fångar:

- tillstånd som bara uppstår vid användning: vald tid, felmeddelande, avlagd röst
- tabbordning och synlig fokusmarkering
- reflow vid 320 px bredd utan vågrät rullning (1.4.10)
- påtvingade textavstånd (1.4.12)
- beröringsytornas storlek
- vad en skärmläsare faktiskt läser upp, via webbläsarens tillgänglighetsträd

Granskade sidor: översikten, en personsida, en bokningssida, avbokningssidan,
en omröstningssida och sidan för nytt lösenord.

## Resultat

**Inga fel enligt axe-core på någon av sidorna**, varken i utgångsläget eller i de
tillstånd som uppstår under användning. Kontrastregeln kördes och godkände samtliga
19 textelement — färgtemat mörknas automatiskt tills det klarar 4,5:1, vilket är
inbyggt i tjänsten och täcks av enhetstester.

Tre brister hittades av de egna kontrollerna och är åtgärdade:

| Brist | Kriterium | Åtgärd |
| --- | --- | --- |
| Fel i bokningsformuläret pekade inte ut vilket fält som var fel, och fokus flyttades inte dit | 3.3.1 Felidentifiering | Fältet markeras med `aria-invalid`, fokus flyttas dit och meddelandet namnger fältet |
| Logotypens länk fick sitt namn enbart från `title`, som läses upp inkonsekvent och inte syns på pekskärm | 2.4.4, 4.1.2 | Namnet sätts med `aria-label` |
| Porträttens initialer lästes upp som en del av länknamnet | 1.1.1 | Platshållaren är `aria-hidden`; skärmläsaren läser "Thomas Wennersten CTO 2 mötestyper" |

## Kvarstår att bevaka

- **Sidorna kräver JavaScript.** Utan det visas inga bokningsbara tider. Det är
  inget WCAG-fel i sig, men för en tjänst som möter invånare är det en verklig
  begränsning som bör vägas in.
- **Beröringsytor.** Radioknapparna i omröstningen är 13×13 px, men hela etiketten
  är klickbar, vilket ger en tillräcklig yta i praktiken. WCAG 2.2 skärper kravet
  (2.5.8, 24×24 px) och då bör kontrollerna förstoras.
- **Ingen granskning med riktig skärmläsare.** Tillgänglighetsträdet är kontrollerat,
  men NVDA, JAWS eller VoiceOver har inte använts. Det bör göras innan tjänsten
  används brett mot invånare.
- Ingen `favicon.ico` finns, vilket ger ett 404-svar i webbläsarens konsol. Ingen
  tillgänglighetsfråga, men lätt att åtgärda.

## Upprepa granskningen

Verktygskedjan ligger utanför repot eftersom den kräver Chromium. Kort recept:
kör sidorna i puppeteer med `--disable-dev-shm-usage`, injicera `axe.min.js` och
kör `axe.run` med taggarna ovan. Granska även de tillstånd som uppstår vid
användning — det var där samtliga brister fanns.
