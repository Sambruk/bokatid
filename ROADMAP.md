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
- Agent-API (MCP) med personliga agentnycklar: lista tjänster, lediga tider, boka,
  egna bokningar och avbokning (prövat utan kalenderkoppling). Se docs/agent-api.md
- Bokning om en tjänst eller ett projekt: lista med sök på startsidan, egen sida per
  post, tider då någon av de ansvariga är ledig, rundgång mellan dem (prövat med
  testvärdar utan kalenderkoppling)

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
- Rundgång även för vanliga mötestyper med flera värdar (finns i dag bara för
  bokning om tjänst eller projekt)
- Multi-tenant: flera organisationer i samma installation
- OAuth 2.1 för MCP-klienter, så att användaren loggar in direkt i sin agent

## Bidra

Verksamheter i offentlig sektor som vill använda eller vidareutveckla tjänsten är
välkomna att höra av sig till [Sambruk](https://sambruk.se). Felrapporter tas emot
tacksamt, särskilt kring tidszoner, kalenderkopplingen och tillgänglighet.
