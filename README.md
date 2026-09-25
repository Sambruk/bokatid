# Boka tid

Mötesbokning för offentlig sektor. En person publicerar sina bokningsbara tider,
andra väljer en tid som passar, och mötet hamnar i kalendern. Självdriftad, på svenska, med uppgifterna kvar hos
verksamheten.

Utvecklad av [Sambruk](https://sambruk.se) som öppen källkod.

## Varför

Kommuner som vill erbjuda tidsbokning hamnar i dag oftast hos en amerikansk
molntjänst. Det är svårt att förena med kraven på var personuppgifter får
hanteras, och det låser upplägget till en leverantör. Boka tid är litet nog att
en kommun kan läsa igenom koden, driftsätta den själv och lita på den.

## Vad den gör

- Mötestyper med egen längd, buffertar, framförhållning och bokningsfönster
- Veckoschema per värd, plus undantag för enskilda datum (semester, röda dagar)
- Publik bokningssida utan inloggning och utan kakor för besökaren
- Översikt över allt som går att boka: tjänster med en värd grupperade per person,
  och tjänster med flera värdar under rubriken Gruppbokningar. Personsidan visar
  både personens egna mötestyper och de gruppbokningar hen deltar i
- Bekräftelse och avbokningslänk via e-post, med kalenderfil (ICS)
- Tvåvägskoppling mot Microsoft 365: läser ledig/upptaget, skriver in mötet med
  Teams-länk — se [docs/M365-KOPPLING.md](docs/M365-KOPPLING.md)
- Egna frågor till bokaren per mötestyp
- **Omröstning om mötestid** (som Doodle): föreslå flera tider, låt flera externa
  parter svara ja / om jag måste / nej, och besluta en tid. Förslagen går bara att
  välja bland värdens lediga tider, de reserveras preliminärt i kalendern, och när
  tiden beslutas bokas mötet och reservationerna släpps
- **Bokningstjänster med flera värdar:** välj kollegor ur användarlistan, och bara
  tider då samtliga är lediga visas — enligt både veckoscheman och kalendrar.
  Alla värdar bjuds in till mötet
- **Superadmin:** användaradministration, och organisationens namn, logotyp,
  webbadress och färgtema som visas på alla publika sidor
- Granskningslogg över bokningar, avbokningar, omröstningar och kalenderkopplingar
- Inloggning med Microsoft: en kollega i en tillåten e-postdomän får konto och
  kalenderkoppling i ett enda klick, utan lösenord och utan administratörsroll

Tidszon är genomgående Europe/Stockholm, och veckoschemat är lokal tid — tiderna
glider alltså inte en timme när sommartiden slår om. Det finns enhetstester för
just detta.

## Teknik

Vanilla HTML, CSS och JavaScript i webbläsaren. Node med Express och Postgres i
botten. Fyra beroenden: `express`, `pg`, `luxon`, `nodemailer`. Ingen byggkedja,
inget ramverk, inget som behöver kompileras.

```
backend/          Express-server
  lib/slots.js    Tidslogiken — ligger fristående och är enhetstestad
  lib/graph.js    Microsoft 365 via Graph, delegerat med PKCE
  lib/crypto.js   Kryptering av tokens, lösenordshashning
  lib/mail.js     E-post och ICS-filer
  test/           node --test
  lib/poll-routes.js  Omröstningar: skapa, rösta, besluta
frontend/         Publika sidor och administration
db/schema.sql     Databasschema
docs/             Driftdokumentation
```

## Komma igång

```bash
git clone <repo> boka-tid && cd boka-tid
cp .env.example .env
# Generera hemligheter:
#   openssl rand -hex 24   → BOKA_DB_PASSWORD
#   openssl rand -hex 32   → BOKA_SESSION_SECRET
#   openssl rand -hex 32   → BOKA_TOKEN_KEY   (måste vara exakt 64 tecken hex)
docker compose up -d
```

Vid första starten läggs en värd upp enligt `BOKA_ADMIN_*` i `.env`, med
veckoschema måndag–fredag 09–16 och en mötestyp att utgå från. Logga in på
`/admin` och ändra.

Kör testerna:

```bash
docker run --rm -v "$PWD/backend:/app" -w /app node:20-alpine \
  sh -c "npm install && node --test test/"
```

### Variabler

| Variabel | Betydelse |
| --- | --- |
| `BOKA_DB_PASSWORD` | Lösenord till Postgres |
| `BOKA_SESSION_SECRET` | Hemlighet för sessioner |
| `BOKA_TOKEN_KEY` | 32 byte hex. Krypterar M365-tokens i vila |
| `BOKA_ADMIN_EMAIL` `_NAME` `_SLUG` `_PASSWORD` | Första värden som läggs upp |
| `BOKA_PUBLIC_URL` | Publik adress, används i länkar och som OAuth-redirect |
| `BOKA_SMTP_*` | Utgående e-post. Använd en avsändardomän som er e-postserver signerar med DKIM och som står i domänens SPF — annars hamnar bekräftelserna i skräpposten, ofta utan att något syns i loggarna |
| `BOKA_ALLOWED_EMAIL_DOMAINS` | Domäner som får skapa konto via Microsoft-inloggning |
| `BOKA_GALLRING_*_DAGAR` | Gallringstider för bokningar, omröstningar och logg |
| `BOKA_MS_TENANT_ID` `_CLIENT_ID` `_CLIENT_SECRET` | Microsoft 365, frivilligt |

Alla variabler har prefixet `BOKA_` med avsikt: utan prefix kan namn som
`ADMIN_PASSWORD` eller `SMTP_HOST` redan finnas i värdens miljö, och då vinner
värdens värde över `.env` vid interpolation i docker compose. Det felet är tyst
och kostar en timme att hitta.

## Organisation och roller

Tre roller: **användare** (`host`), **superadmin** (`admin`) och **extern part**
(`extern`) — leverantörer och samverkansparter utanför organisationen. En användare
sköter sina egna bokningstjänster, tider och omröstningar. Superadmin lägger
dessutom upp konton, sätter roller, stänger av konton och bestämmer
organisationens utseende.

Superadmin redigerar en användares namn, titel, kortnamn, e-postadress, roll och
status i ett och samma formulär, och kan sätta ett valt lösenord eller låta
tjänsten slumpa ett.

### Lösenord

Tre vägar, alla med minst 12 tecken som krav:

- **Superadmin sätter ett lösenord** när kontot skapas eller ändras.
- **Användaren återställer själv** via "Glömt lösenordet?" på inloggningssidan.
  Länken mejlas till kontots adress, gäller i en timme och kan användas en gång.
- **Användaren byter som inloggad** under fliken Konto, med nuvarande lösenord som
  kontroll.

Återställningsformuläret svarar likadant oavsett om adressen finns eller inte —
annars blir det ett sätt att ta reda på vilka konton som existerar. Vad som
faktiskt hände står i granskningsloggen. Länkarna lagras som sha256-hash, så en
läckt databas inte innehåller användbara länkar, och varje lösenordsbyte säger
upp alla pågående sessioner: har någon annan kommit åt kontot kastas den ut.

Den som loggar in med Microsoft behöver inget lösenord alls. Två saker att veta: en ändrad e-postadress är den
personen loggar in med i fortsättningen, även via Microsoft (kalenderkopplingen
följer med kontot), och ett ändrat kortnamn gör tidigare delade bokningslänkar
ogiltiga.

Superadmin kan inte ändra sin egen roll eller stänga av sig själv, och den sista
aktiva superadminen kan inte degraderas. Utan de spärrarna går installationen att
låsa ute sig själv ur.

Organisationen sätter också rubriken och ingressen på startsidan, och texten på
omröstningarnas mellanalternativ. Lämnas de tomma används tjänstens egna
standardtexter.

Organisationens namn, logotyp och webbadress visas i sidhuvudet på varje publik
sida: bokningssidor, avbokning och omröstningar. Logotypen kontrolleras på sitt
faktiska innehåll (magiska byte), inte på filändelsen, och bara PNG, JPEG och
WebP tas emot — en SVG kan bära skript och serveras här från samma ursprung.

### Externa parter och kalenderprenumeration

En extern part har inget konto i organisationens Microsoft 365 och ska inte heller
ha det. I stället delar de en **läsbar kalenderlänk** (ICS) ur Outlook, Google eller
Nextcloud, och tjänsten prenumererar på den. Läsning är allt som är möjligt:
tjänsten kan aldrig skriva i deras kalender, och det är en egenskap hos
konstruktionen, inte en inställning som kan råka ändras.

Deras upptagna tider räknas in precis som en intern kalender. Bokas ett möte skapas
det i den interna värdens kalender, och den externa parten bjuds in som deltagare —
de får alltså en vanlig kalenderinbjudan att tacka ja till.

Tre saker som gör funktionen tillförlitlig i stället för farlig:

- **Återkommande möten vecklas ut.** Ett veckomöte som inte expanderas skulle visa
  bokade tider som lediga. Tidszoner, undantag (EXDATE) och ändrade enstaka
  förekomster hanteras, och allt täcks av enhetstester.
- **Tiderna sparas i databasen.** Går leverantörens server inte att nå används det
  senast kända i stället för att deras bokade tider plötsligt visas som lediga.
  Vid en bokning läses kalendern om, eftersom en bokning är sällsynt och får kosta
  några sekunder.
- **Adressen kontrolleras mot interna nät** innan något hämtas, även vid
  omdirigeringar. Annars hade fältet kunnat användas för att nå tjänster som bara
  är åtkomliga inifrån servern.

Den externa parten behöver inget konto för att sköta sin del. Superadmin skickar
en **personlig länk**, och där kan de klistra in eller byta sin kalenderadress
själva — samma mönster som avbokningslänken. Sidan visar aldrig den sparade
adressen i klartext, bara vilken server den pekar på: en ICS-adress ur Outlook
eller Google innehåller ofta en hemlig nyckel till kalendern. Läcker länken kan
superadmin förnya den, och den gamla slutar gälla direkt.

Tider märkta som lediga i kalendern (`TRANSP:TRANSPARENT` eller Outlooks
busystatus `FREE`) blockerar ingenting — den som satt "ledig" menar att tiden går
att boka.

### Färgtemat och kontrast

Färgtemat anges som en hexkod, men används inte rakt av. En signaturfärg är vald
för tryck och logotyper, inte för text på skärm: Sambruks gröna `#58A618` ger bara
3,05:1 mot vitt och klarar inte WCAG 2.1 AA, som kräver 4,5:1 för text. Tjänsten
mörknar därför färgen till en textvariant som klarar kravet — `#427c12`, 5,09:1 —
och använder originalfärgen enbart dekorativt. Superadmin ser exakt vad som
hände och varför. Ett färgval ska inte kunna göra tjänsten oläsbar.

## Mobil

De publika sidorna är byggda för telefon först: besökaren kommer oftast från en
länk i ett mail. Beröringsytor är minst 44 px höga, fält minst 16 px stora så att
iOS inte zoomar in vid fokus, tidsknapparna ligger i ett rutnät som anpassar sig,
formulärrader staplas under 560 px, tabeller kan rullas i sidled i en egen
behållare, och ingenting hindrar besökaren från att zooma.

## Personuppgifter

Om en bokning sparas: namn, e-postadress, eventuell organisation, svar på de
frågor mötestypen ställer, samt tidpunkt. Det är uppgifter som behövs för att
genomföra mötet.

- Bokaren får en avbokningslänk och kan avboka själv.
- Ur värdens kalender läses bara ledig/upptaget. Inga mötesrubriker.
- Ingen spårning, inga tredjepartsanrop, inga kakor på den publika sidan.
- **Automatisk gallring** körs en gång per dygn i appens egen process, och även
  vid start så att en server som varit nere hinner ikapp. Förvalt: bokningar
  raderas 90 dagar efter mötets sluttid, avslutade omröstningar 90 dagar efter
  beslut eller avbrytning, granskningsloggen efter 365 dagar. Gränserna sätts med
  `BOKA_GALLRING_BOKNINGAR_DAGAR`, `BOKA_GALLRING_OMROSTNINGAR_DAGAR` och
  `BOKA_GALLRING_LOGG_DAGAR`; `0` stänger av gallringen för den kategorin.
  Adminvyn visar vad som skulle gallras just nu och låter jobbet köras direkt.
  Öppna omröstningar gallras aldrig automatiskt — de väntar på svar och håller
  tider reserverade i kalendern.
- Bokaren får **ett** mail, inte två: skrevs mötet i värdens kalender är Outlooks
  inbjudan beskedet, och avbokningslänken ligger överst i händelsens text.

Verksamheten som driftar tjänsten är personuppgiftsansvarig och behöver göra sin
egen bedömning, inklusive gallringstid och information till de som bokar.

## Status

Version 0.1. Används av Sambruks kansli. Kalenderkopplingen är verifierad mot en
riktig Microsoft 365-kalender 2026-09-24: bokningen skrivs in i Outlook med
Teams-länk, bokaren står som deltagare, tiden försvinner ur de lediga tiderna och
en avbokning tar bort mötet ur kalendern igen. Teams-länken fungerar med enbart
`Calendars.ReadWrite`.

Två verktyg kontrollerar kopplingen i drift:

```bash
docker compose exec -T boka-tid-app node verifiera-entra.js       # uppgifterna mot Entra
docker compose exec -T boka-tid-app node verifiera-kalender.js    # den sparade kopplingen
docker compose exec -T boka-tid-app node verifiera-flode.js --bokare namn@exempel.se
docker compose exec -T boka-tid-app node verifiera-omrostning.js --deltagare namn@exempel.se
docker compose exec -T boka-tid-app node verifiera-epost.js --till namn@exempel.se
docker compose exec -T boka-tid-app node verifiera-sidhuvud.js
```

Det sista gör en verklig bokning, kontrollerar hela kedjan och städar efter sig.

Inte byggt ännu: ombokning via länk (avboka och boka nytt fungerar), flera språk,
flera värdar med rundgång, och multi-tenant för olika organisationer i samma
installation. Se [ROADMAP.md](ROADMAP.md).

## Licens

**EUPL-1.2** — European Union Public Licence. Se [LICENSE](LICENSE).

`SPDX-License-Identifier: EUPL-1.2`

EUPL är framtagen av EU-kommissionen och finns i rättsligt likvärdiga versioner på
alla 23 officiella EU-språk, vilket gör den lämplig när svenska kommuner ska
återanvända och vidareutveckla koden. Den är en svag copyleft: ändringar som sprids
vidare ska delas under samma villkor, medan licensens bilaga räknar upp
kompatibla licenser (bland andra GPL, LGPL, MPL och EPL) som koden får
kombineras med och distribueras under.

## Bidra

Verksamheter i offentlig sektor som vill använda eller vidareutveckla tjänsten är
välkomna att höra av sig till Sambruk. Rapportera gärna fel — särskilt kring
tidszoner, kalenderkopplingen och tillgänglighet.

## Omröstning om mötestid

Ska flera parter komma överens om en tid fungerar en vanlig bokningssida dåligt:
den första som bokar bestämmer. En omröstning löser det.

1. **Värden föreslår tider.** Bara lediga tider går att välja — upptagen tid i
   Outlook, redan bokade möten och tider som en annan omröstning har reserverat
   filtreras bort av samma slotmotor som bokningssidan använder. Försöker någon
   ändå skicka in en upptagen tid avvisas den med `409`.
2. **Tiderna reserveras preliminärt.** Varje förslag blir en händelse i värdens
   kalender markerad som preliminär (`showAs: tentative`), utan deltagare — ingen
   utomstående ska få en inbjudan till en tid som kanske inte blir av. Kollegor ser
   tiden som bokad, och tjänsten slutar erbjuda den på den vanliga bokningssidan.
3. **Deltagarna svarar** ja, om jag måste, eller nej, på en sida utan inloggning.
   De ser varandras namn men aldrig varandras e-postadresser. Utfärdaren kan välja
   att inte visa svaren för deltagarna alls.
4. **Värden beslutar en tid.** Då bokas mötet på riktigt med Teams-länk och alla
   som svarat som deltagare, och **samtliga preliminärbokningar tas bort** ur
   kalendern. Avbryts omröstningen i stället släpps reservationerna och deltagarna
   får besked.

Blockeringen ligger i databasen och inte bara i kalendern, så en reserverad tid
kan inte bokas bort av någon annan ens när M365-kopplingen tillfälligt är nere.

### Rensning

En omröstning sparar namn och e-postadresser till externa deltagare, så den ska
inte ligga kvar längre än den behövs. I adminvyn går det att ta bort en enskild
omröstning, och att rensa alla beslutade och avbrutna som är äldre än ett valt
antal dagar. Öppna omröstningar lämnas alltid orörda, eventuella reservationer
släpps ur kalendern först, och ett redan bokat möte ligger kvar — underlaget
städas bort, inte mötet.
