# Vad som är gjort och vad som återstår

## Fungerar och är prövat mot en riktig Microsoft 365-kalender

- Mötestyper med längd, buffertar, framförhållning, bokningsfönster och egna frågor
- Veckoschema per värd, plus undantag för enskilda datum
- Bokningstjänster med flera värdar, där bara tider då samtliga är lediga visas
- Publik bokningssida utan inloggning och utan kakor
- Tvåvägskoppling mot Microsoft 365: läser ledig/upptaget, skriver in mötet med
  Teams-länk, tar bort det vid avbokning
- Inloggning med Microsoft, med domänspärr för vilka som får skapa konto
- Omröstning om mötestid med preliminärbokningar i kalendern
- Superadmin: användare, organisationens namn, logotyp, webbadress och färgtema
- Automatisk gallring av bokningar, avslutade omröstningar och granskningslogg
- Enhetstester för tidslogiken, inklusive sommartidsskiftet, och för kontrastkravet

## Återstår

**Före bredare användning**

- Tillgänglighetsgranskning enligt WCAG 2.1 AA av de publika sidorna
- Oberoende säkerhetsgranskning
- Sidorna kräver JavaScript. För en tjänst som möter invånare bör det vägas in

**Funktioner**

- Ombokning via länk (i dag: avboka och boka nytt)
- Avisering till värden när alla svarat på en omröstning
- Sista svarsdag som stänger omröstningen automatiskt
- Fler språk än svenska
- Rundgång mellan flera värdar, så bokningar fördelas
- Multi-tenant: flera organisationer i samma installation

## Bidra

Verksamheter i offentlig sektor som vill använda eller vidareutveckla tjänsten är
välkomna att höra av sig till [Sambruk](https://sambruk.se). Felrapporter tas emot
tacksamt, särskilt kring tidszoner, kalenderkopplingen och tillgänglighet.
