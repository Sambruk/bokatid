'use strict';
// Kontrollerar att MS_TENANT_ID, MS_CLIENT_ID och MS_CLIENT_SECRET hänger ihop,
// genom att begära ett token med appens egna uppgifter. Skriver aldrig ut
// hemligheten, bara om den duger eller inte.
//
// Körs inifrån app-containern:
//   docker compose exec -T boka-tid-app node verifiera-entra.js

const tenant = process.env.MS_TENANT_ID || '';
const clientId = process.env.MS_CLIENT_ID || '';
const secret = process.env.MS_CLIENT_SECRET || '';
const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rad(etikett, ok, kommentar) {
  console.log(`${ok ? '  OK  ' : ' FEL  '} ${etikett}${kommentar ? ' — ' + kommentar : ''}`);
  return ok;
}

(async () => {
  console.log('\nKontroll av Entra-uppgifterna\n');

  let allt = true;
  allt &= rad(
    'Katalog-id (MS_TENANT_ID)',
    GUID.test(tenant),
    GUID.test(tenant) ? null : tenant ? 'ser inte ut som ett guid' : 'saknas'
  );
  allt &= rad(
    'Program-id (MS_CLIENT_ID)',
    GUID.test(clientId),
    GUID.test(clientId) ? null : clientId ? 'ser inte ut som ett guid' : 'saknas'
  );

  // En klienthemlighets *värde* är omkring 40 tecken och innehåller tecken
  // utanför hex. Är värdet ett guid har troligen "Hemligt id" klistrats in.
  const serUtSomGuid = GUID.test(secret);
  allt &= rad(
    'Klienthemlighet (MS_CLIENT_SECRET)',
    Boolean(secret) && !serUtSomGuid,
    !secret
      ? 'saknas'
      : serUtSomGuid
        ? 'det här är ett guid, alltså troligen "Hemligt id". Använd fältet "Värde".'
        : `${secret.length} tecken`
  );

  if (!allt) {
    console.log('\nRätta ovanstående i /opt/app/boka-tid/.env och kör igen.\n');
    process.exit(1);
  }

  console.log('\nFrågar Microsoft om uppgifterna godtas…');
  try {
    const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: secret,
        scope: 'https://graph.microsoft.com/.default',
      }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.access_token) {
      console.log('  OK   Microsoft godtar katalog-id, program-id och hemligheten.\n');
      console.log('Kontrollera till sist att omdirigerings-URI:n i Entra är exakt:');
      console.log(`  ${publicUrl}/auth/ms/callback\n`);
      console.log('Sedan: logga in på /boka/admin → fliken Microsoft 365 → Koppla min kalender.\n');
      process.exit(0);
    }

    const kod = String(data.error_description || data.error || `HTTP ${res.status}`).split('\n')[0];
    console.log(` FEL   Microsoft nekade: ${kod}\n`);
    if (/AADSTS7000215/.test(kod)) console.log('Tolkning: hemligheten är fel. Använd fältet "Värde", inte "Hemligt id".\n');
    else if (/AADSTS700016|AADSTS700027/.test(kod)) console.log('Tolkning: program-id hittas inte i den katalogen. Kontrollera att båda id:na kommer från samma appregistrering.\n');
    else if (/AADSTS90002/.test(kod)) console.log('Tolkning: katalog-id finns inte. Kontrollera Katalog-id (tenant).\n');
    else if (/AADSTS7000222/.test(kod)) console.log('Tolkning: hemligheten har gått ut. Skapa en ny i Entra.\n');
    process.exit(1);
  } catch (err) {
    console.log(` FEL   Kunde inte nå Microsoft: ${err.message}\n`);
    process.exit(1);
  }
})();
