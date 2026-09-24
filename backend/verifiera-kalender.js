'use strict';
// Testar den sparade M365-kopplingen skarpt: förnyar tokenet, läser kalendern,
// hämtar ledig/upptaget och skapar ett testmöte som raderas direkt efteråt.
//
//   docker compose exec -T boka-tid-app node verifiera-kalender.js            (läser bara)
//   docker compose exec -T boka-tid-app node verifiera-kalender.js --skriv    (skapar och tar bort ett testmöte)

const { q } = require('./lib/db');
const { decrypt, encrypt } = require('./lib/crypto');
const graph = require('./lib/graph');

const SKRIV = process.argv.includes('--skriv');

const rad = (ok, text, extra) => console.log(`${ok ? '  OK  ' : ' FEL  '} ${text}${extra ? ' — ' + extra : ''}`);

(async () => {
  console.log('\nKontroll av kalenderkopplingen\n');

  if (!graph.isConfigured()) {
    rad(false, 'M365 är inte konfigurerad', 'fyll i BOKA_MS_* i .env');
    process.exit(1);
  }

  const { rows } = await q(
    `SELECT a.*, u.email, u.name FROM ms_accounts a JOIN users u ON u.id = a.user_id
     ORDER BY a.user_id LIMIT 10`
  );
  if (!rows.length) {
    rad(false, 'Ingen kalender är kopplad', 'logga in i adminvyn och koppla den');
    process.exit(1);
  }

  let fel = 0;
  for (const konto of rows) {
    console.log(`Värd: ${konto.name} <${konto.email}>`);
    rad(true, `Kopplat Microsoft-konto: ${konto.ms_upn}`);

    if (konto.ms_upn && konto.email && !likaDoman(konto.ms_upn, konto.email)) {
      rad(false, 'Microsoft-kontot har en annan domän än värdens adress i tjänsten',
        'kontrollera att rätt konto kopplats');
      fel++;
    }

    // Förnya tokenet, precis som servern gör vid en bokning.
    let token;
    try {
      const data = await graph.refresh(decrypt(konto.refresh_token));
      await q(
        `UPDATE ms_accounts SET access_token = $2, refresh_token = COALESCE($3, refresh_token),
           expires_at = now() + ($4 || ' seconds')::interval, last_error = NULL, updated_at = now()
         WHERE user_id = $1`,
        [konto.user_id, encrypt(data.access_token), data.refresh_token ? encrypt(data.refresh_token) : null,
         String(data.expires_in || 3600)]
      );
      token = data.access_token;
      rad(true, 'Tokenet kunde förnyas');
    } catch (err) {
      rad(false, 'Tokenet kunde inte förnyas', err.message);
      fel++;
      continue;
    }

    const kalender = await graph.calendarUsable(token);
    if (!kalender.ok) {
      rad(false, 'Kalendern kan inte läsas', kalender.error);
      if (/mailbox is either inactive|MailboxNotEnabledForRESTAPI/i.test(kalender.error || '')) {
        console.log('        Tolkning: kontot har ingen brevlåda i Microsoft 365. Koppla om med');
        console.log('        en adress som har Exchange-licens, inte ett administratörskonto.');
      }
      fel++;
      continue;
    }
    rad(true, 'Kalendern kan läsas');

    const fran = new Date();
    const till = new Date(Date.now() + 7 * 86400_000);
    try {
      const upptaget = await graph.busyIntervals(token, {
        upn: konto.ms_upn || konto.email,
        fromIso: fran.toISOString(),
        toIso: till.toISOString(),
      });
      rad(true, `Ledig/upptaget hämtat för sju dagar framåt`, `${upptaget.length} upptagna poster`);
    } catch (err) {
      rad(false, 'Ledig/upptaget kunde inte hämtas', err.message);
      fel++;
    }

    if (!SKRIV) {
      console.log('        (kör med --skriv för att även testa att skapa ett möte)\n');
      continue;
    }

    // Skapa ett testmöte långt fram i tiden, utan deltagare, och ta bort det.
    const start = new Date(Date.now() + 30 * 86400_000);
    start.setUTCHours(3, 0, 0, 0);
    const slut = new Date(start.getTime() + 15 * 60_000);
    let skapat;
    try {
      skapat = await graph.call(token, '/me/events', {
        method: 'POST',
        body: {
          subject: 'Boka tid — teknisk kontroll, kan ignoreras',
          start: { dateTime: start.toISOString().replace('Z', ''), timeZone: 'UTC' },
          end: { dateTime: slut.toISOString().replace('Z', ''), timeZone: 'UTC' },
          isOnlineMeeting: true,
          onlineMeetingProvider: 'teamsForBusiness',
        },
      });
      rad(true, 'Möte kunde skapas i kalendern');
      const lank = skapat.onlineMeeting?.joinUrl || skapat.onlineMeetingUrl;
      if (lank) rad(true, 'Teams-länk skapades');
      else {
        rad(false, 'Ingen Teams-länk i svaret',
          'lägg till behörigheten OnlineMeetings.ReadWrite i Entra, eller kontrollera Teams-licensen');
        fel++;
      }
    } catch (err) {
      rad(false, 'Möte kunde inte skapas', err.message);
      fel++;
    }

    if (skapat?.id) {
      try {
        await graph.call(token, `/me/events/${encodeURIComponent(skapat.id)}`, { method: 'DELETE' });
        rad(true, 'Testmötet togs bort igen');
      } catch (err) {
        rad(false, 'Testmötet kunde INTE tas bort — radera det manuellt', err.message);
        fel++;
      }
    }
    console.log('');
  }

  console.log(fel ? `Klart med ${fel} fel.\n` : 'Allt fungerar.\n');
  process.exit(fel ? 1 : 0);
})().catch((err) => {
  console.error('Kunde inte köra kontrollen:', err.message);
  process.exit(1);
});

function likaDoman(a, b) {
  return String(a).split('@')[1]?.toLowerCase() === String(b).split('@')[1]?.toLowerCase();
}
