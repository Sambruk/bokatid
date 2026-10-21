# Agent-API (MCP)

Boka tid har en MCP-endpoint som AI-agenter kan ansluta till, t.ex. Claude,
Eneo eller en egen agent. Agenten kan lista tjänster, visa lediga tider, boka,
se och avboka nyckelägarens egna bokningar, och skapa och sköta omröstningar om
mötestid med nyckelägaren som värd.

- **Adress:** `<PUBLIC_URL>/mcp` (visas i adminvyn under Konto → Agentnycklar)
- **Transport:** MCP Streamable HTTP, tillståndslös (`POST`, JSON-svar, inga sessioner)
- **Autentisering:** `Authorization: Bearer bt_…`

## Agentnycklar

En agentnyckel skapas av en inloggad användare i adminvyn (Konto → Agentnycklar).

| Egenskap | Hur |
|---|---|
| Knuten till | En användare. Agenten kan aldrig mer än den användaren. |
| Behörigheter | `las` – tjänster, lediga tider, egna bokningar och omröstningar · `boka` – boka åt någon · `avboka` – avboka egna bokningar · `omrostning` – skapa och sköta omröstningar (mejlar externa mottagare, reserverar tid i kalendern) |
| Lagring | Bara SHA-256 av nyckeln och ett kort prefix. Nyckeln visas en gång. |
| Giltighet | 1–365 dagar, 90 som standard. Alltid ett utgångsdatum. |
| Spärr | Direkt i adminvyn. Gäller från nästa anrop (ingen cache). |
| Skapas av | Endast inloggad session – en agent kan aldrig skapa eller förlänga nycklar. |
| Takt | 120 anrop/minut och 20 bokningar/10 minuter per nyckel. Omröstningar: 5 nya och 100 inbjudningar/10 minuter per nyckel, påminnelse högst en gång per omröstning och 12 timmar. |
| Spårbarhet | Bokningar, avbokningar och omröstningsåtgärder via agent loggas i granskningsloggen med nyckelns id och namn (`viaAgent`). |

Agenten ser bara de verktyg nyckelns behörigheter tillåter.

## Verktyg

| Verktyg | Behörighet | Gör |
|---|---|---|
| `lista_tjanster` | `las` eller `boka` | Bokningsbara tjänster per person och gemensamma tjänster |
| `lediga_tider` | `las` eller `boka` | Lediga starttider dag för dag, plus tjänstens frågor |
| `boka` | `boka` | Bokar en tid; inbjudan och avbokningslänk mejlas till personen |
| `mina_bokningar` | `las` | Nyckelägarens kommande eller passerade bokningar |
| `avboka` | `avboka` | Avbokar en av nyckelägarens bokningar |
| `omrostning_tider` | `las` eller `omrostning` | Lediga starttider i nyckelägarens kalender för en given mötestid |
| `mina_omrostningar` | `las` eller `omrostning` | Nyckelägarens omröstningar, med antal inbjudna och svarande |
| `visa_omrostning` | `las` eller `omrostning` | Tider med ja/kanske/nej, deltagarnas svar, vem som inte svarat, reservationerna |
| `skapa_omrostning` | `omrostning` | Skapar en omröstning; `forhandsgranska` visar resultatet utan att spara eller mejla |
| `lagg_till_deltagare` | `omrostning` | Bjuder in ytterligare en person till en öppen omröstning |
| `paminn` | `omrostning` | Mejlar inbjudan på nytt till dem som inte svarat |
| `besluta_tid` | `omrostning` | Beslutar en tid: mötet i kalendern, inbjudningar, övriga reservationer släpps |
| `avbryt_omrostning` | `omrostning` | Avbryter, släpper reservationerna och meddelar de inbjudna |

Allt går genom samma kontroller som webbsidan och adminvyn: lediga tider, spärren
mot dubbelbokning, kalenderskrivning i Microsoft 365 och e-post. Verktygen anropar
tjänstens eget REST-API med agentens nyckel, så det finns bara ett ställe där
reglerna ligger.

## Omröstningar via agent

Arbetsgången, som också står i serverns instruktioner till agenten:

1. `omrostning_tider` – lediga starttider för önskad mötestid.
2. `skapa_omrostning` med `forhandsgranska: true` – agenten visar rubrik, tider och
   mottagare för användaren och får dem bekräftade. Inget sparas, inget mejlas.
3. `skapa_omrostning` utan förhandsgranskning, gärna med `klient_referens`. Svaret
   kommer direkt; inbjudningar och preliminärbokningar görs i bakgrunden.
4. `visa_omrostning` – följ svaren.
5. `besluta_tid` (med `tid_id` från `visa_omrostning`) eller `avbryt_omrostning`.

Skydd:

- **En föreslagen tid som inte är ledig** ger fel, och ingenting sparas.
- **Idempotens:** samma `klient_referens` igen ger den omröstning som redan finns,
  utan nya utskick. Referensen är unik per nyckelägare.
- **Bara egna omröstningar.** En agent ser och sköter bara nyckelägarens
  omröstningar, även när ägaren är superadmin.
- **Inga personliga svarslänkar** lämnas ut till agenten; med en sådan kan man
  svara i en deltagares namn.
- **Ta bort, rensa, stänga och öppna igen** är inte öppna för agenter.
- Befintliga tak gäller: högst 20 tider och 50 deltagare per omröstning.

## Ansluta

**Claude (anpassad connector):** URL `<PUBLIC_URL>/mcp`, lägg till headern
`Authorization` med värdet `Bearer bt_…`.

**Claude Code:**

```sh
claude mcp add --transport http boka-tid <PUBLIC_URL>/mcp \
  --header "Authorization: Bearer bt_…"
```

**Test med curl:**

```sh
curl -s <PUBLIC_URL>/mcp \
  -H "Authorization: Bearer bt_…" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## REST för agenter utan MCP

Nyckeln fungerar också direkt mot REST-API:t: de publika delarna
(`/api/oversikt`, `/api/event-type/…`, `/api/slots/…`, `POST /api/book/…` med
behörigheten `boka`) samt `GET /api/admin/bookings` (`las`) och
`POST /api/admin/bookings/:id/cancel` (`avboka`).

Omröstningar: `GET /api/admin/poll-slots`, `GET /api/admin/polls` och
`GET /api/admin/polls/:id` (`las` eller `omrostning`), samt `POST /api/admin/polls`
och `POST /api/admin/polls/:id/participants|remind|decide|cancel` (`omrostning`).
`POST /api/admin/polls` tar också `dry_run: true` (förhandsgranskning) och
`client_ref` (idempotens).

Övriga delar av admin-API:t svarar 403 för agentnycklar.

## Test

- `node --test test/` – bland annat vitlistan och vilka verktyg varje behörighet ger.
- `node verifiera-mcp-omrostning.js --deltagare a@…,b@…,c@… [--kalender värd@…]` –
  skarptest av hela omröstningsflödet via MCP mot en tillfällig testvärd. Skickar
  riktig e-post till adresserna. Med `--kalender` prövas också preliminärbokningarna
  i den användarens Microsoft 365-kalender (70–90 dagar fram, utan deltagare).
  Städar efter sig.

## Varför inte OAuth ännu

MCP-specifikationen beskriver OAuth 2.1 för att en användare ska kunna logga in
direkt i sin agent. Det kräver en auktoriseringsserver med dynamisk
klientregistrering och är planerat som ett senare steg (se ROADMAP.md).
Agentnycklarna är det enkla och granskningsbara alternativet under tiden, och
fungerar med alla MCP-klienter som kan skicka en header.
