# Koppla Boka tid till Microsoft 365

Tjänsten fungerar utan den här kopplingen: värden lägger då in sitt veckoschema
manuellt, och bokningar skickas som kalenderinbjudan via e-post. Kopplingen ger
två saker till:

1. **Dubbelbokning undviks.** Tjänsten läser ledig/upptaget ur värdens kalender.
2. **Mötet hamnar i Outlook automatiskt**, med Teams-länk, och Outlook skickar
   den riktiga inbjudan till bokaren.

Kopplingen är **delegerad**: varje värd godkänner sin egen kalender vid
inloggning. Tjänsten begär aldrig behörighet till andra personers brevlådor.

## Vad som behöver göras — och av vem

Stegen nedan kräver rollen *Programadministratör* eller *Global administratör* i
Sambruks Entra-katalog. Det går inte att göra från den här servern.

### 1. Registrera appen i Entra

1. Gå till [entra.microsoft.com](https://entra.microsoft.com) →
   **Identitet → Program → Appregistreringar → Ny registrering**.
2. Namn: `Boka tid (Sambruk)`.
3. Konton som stöds: **Endast konton i den här organisationskatalogen**
   (enskild tenant). Välj bredare bara om medlemskommuner senare ska logga in
   med sina egna konton — det är ett eget beslut med egna krav.
4. Omdirigerings-URI: typ **Webb**, värde:

   ```
   https://app.sambruk.se/boka/auth/ms/callback
   ```

   Exakt den strängen, inklusive `https` och utan avslutande snedstreck.
5. Registrera.

### 2. Anteckna id och skapa en hemlighet

Entra visar fem värden som alla ser ut som hemligheter. Bara tre av dem används:

| Fält i Entra | Variabel i `.env` |
| --- | --- |
| **Program-id** (Application/client ID) | `BOKA_MS_CLIENT_ID` |
| **Katalog-id** (Directory/tenant ID) | `BOKA_MS_TENANT_ID` |
| **Klienthemlighet → Värde** | `BOKA_MS_CLIENT_SECRET` |
| Objekt-id | används inte — internt id för appobjektet |
| Klienthemlighet → Hemligt id | används inte — bara en referens till hemligheten |

Den vanligaste orsaken till `invalid_client` är att *Hemligt id* klistrats in i
stället för *Värde*. Ett guid i `BOKA_MS_CLIENT_SECRET` är alltid fel.

Gå sedan till **Certifikat och hemligheter → Ny klienthemlighet**. Sätt en
giltighetstid ni faktiskt bevakar (24 månader är rimligt) och kopiera värdet
direkt — det visas bara en gång. Det blir `BOKA_MS_CLIENT_SECRET`.

**Sätt ett kalenderpåminnelse för utgångsdatumet.** När hemligheten går ut
slutar kalenderkopplingen fungera, och felet syns bara som att tider inte
uppdateras. Tjänsten visar då det senaste felet under fliken Microsoft 365.

### 3. Behörigheter

Under **API-behörigheter** ska dessa finnas som *delegerade* behörigheter för
Microsoft Graph:

| Behörighet | Varför |
| --- | --- |
| `User.Read` | Läsa vem som loggat in, för att koppla rätt kalender |
| `Calendars.ReadWrite` | Läsa ledig/upptaget och skriva in bokade möten |
| `offline_access` | Förnya åtkomsten utan att värden loggar in på nytt |

`Calendars.ReadWrite` kan en användare normalt godkänna själv. Om er tenant har
stängt av användarsamtycke behöver en administratör klicka **Ge administratörens
medgivande** en gång — då slipper varje värd godkännandedialogen.

`OnlineMeetings.ReadWrite` behövs **inte** — verifierat i Sambruks tenant
2026-09-24: Teams-länken skapas med enbart `Calendars.ReadWrite` när mötet
skapas med `isOnlineMeeting`.

### 4. Lägg in värdena på servern

I `/opt/app/boka-tid/.env`:

```bash
BOKA_MS_TENANT_ID=...
BOKA_MS_CLIENT_ID=...
BOKA_MS_CLIENT_SECRET=...
```

Starta om appen:

```bash
cd /opt/app/boka-tid && docker compose up -d
```

Kontrollera att servern ser konfigurationen:

```bash
curl -s https://app.sambruk.se/boka/healthz
# {"ok":true,...,"m365":"konfigurerad"}
```

Kontrollera att Microsoft faktiskt godtar uppgifterna. Skriptet frågar Entra med
appens egna uppgifter och skriver aldrig ut hemligheten:

```bash
cd /opt/app/boka-tid && docker compose exec -T boka-tid-app node verifiera-entra.js
```

Det talar om vilket av fälten som är fel, och tolkar Microsofts felkoder — till
exempel att `AADSTS7000215` betyder att hemligheten är fel och `AADSTS7000222`
att den har gått ut.

### 5. Koppla kalendern

Det finns två vägar in, och båda ger samma sak:

- **Logga in med Microsoft** (knappen på inloggningssidan). Kollegan får konto
  automatiskt och kalendern kopplas i samma klick. Konto skapas bara för adresser
  i en domän som står i `BOKA_ALLOWED_EMAIL_DOMAINS` — en gäst i katalogen kan
  alltså inte lägga upp sig själv som värd.
- **Lösenordsinloggning** för det första kontot, och sedan knappen under fliken
  Microsoft 365.

Ingen behöver någon administratörsroll för det här. Varje person godkänner bara
sin egen kalender, och kommer aldrig åt någon annans.


Logga in på <https://app.sambruk.se/boka/admin>, gå till fliken **Microsoft 365**
och klicka **Koppla min Microsoft 365-kalender**. Efter godkännandet ska fliken
visa vilken adress kalendern är kopplad till.

### 6. Verifiera skarpt

1. Boka en tid på din egen publika sida.
2. Kontrollera att mötet dyker upp i din Outlook-kalender, med Teams-länk.
3. Kontrollera att bokaren fick **en** inbjudan, inte två.
4. Lägg in ett möte manuellt i Outlook och kontrollera att den tiden försvinner
   från de lediga tiderna.
5. Avboka via länken i bekräftelsen och kontrollera att mötet försvinner ur
   kalendern.

## Hur uppgifterna hanteras

- Åtkomst- och förnyelsetoken lagras krypterade med AES-256-GCM. Nyckeln ligger
  i `BOKA_TOKEN_KEY` och finns bara i serverns `.env`.
- Ur kalendern hämtas enbart **ledig/upptaget med tidsintervall**. Mötesrubriker,
  deltagare och mötesinnehåll läses aldrig.
- Kopplingen kan brytas när som helst under fliken Microsoft 365. Då raderas
  tokens ur databasen.
- Hemligheten (`client secret`) tillhör organisationen, inte en enskild person.
  Förvara den där ni förvarar andra driftshemligheter.

## Om något inte fungerar

| Symtom | Trolig orsak |
| --- | --- |
| `m365: "ej konfigurerad"` i healthz | Någon av de tre variablerna saknas, eller appen är inte omstartad |
| Microsoft visar `AADSTS50011` | Omdirigerings-URI:n i Entra matchar inte exakt, se steg 1.4 |
| Microsoft visar `AADSTS65001` | Samtycke saknas — låt en administratör ge medgivande, steg 3 |
| `invalid_client` | Klienthemligheten är fel eller har gått ut |
| `The mailbox is either inactive, soft-deleted, or is hosted on-premise` | Kontot som kopplades saknar brevlåda — oftast ett administratörskonto utan Exchange-licens. Koppla om och välj en vanlig arbetsadress i kontovalet |
| Kopplingen tappas efter en tid | Hemligheten har gått ut, eller värden har ändrat lösenord och återkallat sessioner |
| Tider visas men kalendern beaktas inte | Graph-anropet misslyckas tyst och tjänsten faller tillbaka på databasen. Titta i `audit_log` efter `graph_freebusy_failed` |

Granskningsloggen når du så här:

```bash
docker exec boka-tid-boka-tid-postgres-1 psql -U boka -d boka \
  -c "SELECT at, action, detail FROM audit_log ORDER BY id DESC LIMIT 20"
```
