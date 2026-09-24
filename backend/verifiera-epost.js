'use strict';
// Kontrollerar e-postvägen och gör den synlig. Tjänsten skickade länge mail som
// försvann tyst, eftersom relä-containern kastar sina loggar. Det här verktyget
// visar hela SMTP-samtalet och tolkar vanliga fel.
//
//   docker compose exec -T boka-tid-app node verifiera-epost.js                   (bara kontroll)
//   docker compose exec -T boka-tid-app node verifiera-epost.js --till din@adress.se

const nodemailer = require('nodemailer');

const arg = (namn, standard) => {
  const i = process.argv.indexOf(`--${namn}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : standard;
};
const TILL = arg('till', null);

const rad = (ok, text, extra) => {
  console.log(`${ok ? '  OK  ' : ' FEL  '} ${text}${extra ? ' — ' + extra : ''}`);
  return ok;
};

(async () => {
  console.log('\nKontroll av e-postvägen\n');

  const host = process.env.SMTP_HOST || '';
  const port = Number(process.env.SMTP_PORT || 25);
  const sender = process.env.SMTP_SENDER || '';
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';

  let fel = 0;
  if (!rad(Boolean(host), 'SMTP-server angiven', host || 'SMTP_HOST saknas')) fel++;
  if (!rad(Boolean(sender), 'Avsändaradress angiven', sender || 'SMTP_SENDER saknas')) fel++;

  const avsandarDoman = sender.split('@')[1] || '';
  if (/\.elestio\.app$|\.vm\.elestio\.app$/.test(avsandarDoman)) {
    rad(false, 'Avsändardomänen är serverns egen, inte verksamhetens',
      `${avsandarDoman} saknar SPF och DKIM för er domän — mailen skräppostas`);
    fel++;
  } else {
    rad(true, `Avsändardomän: ${avsandarDoman || 'okänd'}`);
  }

  if (user && pass) rad(true, 'Inloggning mot e-postservern konfigurerad', `användare ${user.slice(0, 4)}…`);
  else {
    rad(false, 'Ingen inloggning konfigurerad',
      'SMTP_USER och SMTP_PASS är tomma. Postal kräver inloggning, så utskicken misslyckas');
    fel++;
  }

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: false,
    ignoreTLS: !(user && pass),
    ...(user && pass ? { auth: { user, pass } } : {}),
    connectionTimeout: 15000,
  });

  try {
    await transport.verify();
    rad(true, 'E-postservern svarar och godtar uppgifterna');
  } catch (err) {
    rad(false, 'E-postservern godtar inte uppgifterna', err.message);
    tolka(err.message);
    fel++;
  }

  if (!TILL) {
    console.log('\n        Kör med --till din@adress.se för att skicka ett riktigt testmail.\n');
    process.exit(fel ? 1 : 0);
  }

  console.log(`\nSkickar testmail till ${TILL}…\n`);
  try {
    const info = await transport.sendMail({
      from: `"${process.env.SMTP_SENDER_NAME || 'Boka tid'}" <${sender}>`,
      to: TILL,
      subject: `Boka tid — leveranstest ${new Date().toLocaleString('sv-SE')}`,
      text:
        'Det här är ett testmail från Boka tid.\n\n' +
        'Kom det fram fungerar e-postvägen. Hamnade det i skräpposten behöver ' +
        'avsändardomänens SPF och DKIM ses över.\n',
    });
    rad(true, 'E-postservern tog emot meddelandet', info.response);
    console.log(`\n        Mottaget av servern betyder inte levererat till inkorgen.`);
    console.log(`        Kontrollera Postals meddelandelogg, och titta i skräpposten.\n`);
  } catch (err) {
    rad(false, 'Meddelandet kunde inte skickas', err.message);
    tolka(err.message);
    fel++;
  }

  process.exit(fel ? 1 : 0);
})();

function tolka(meddelande) {
  const m = String(meddelande);
  if (/535|authentication failed|5\.7\.8/i.test(m)) {
    console.log('        Tolkning: användarnamn eller lösenord är fel.');
  } else if (/530|must issue a starttls|authentication required/i.test(m)) {
    console.log('        Tolkning: servern kräver inloggning. Fyll i BOKA_SMTP_USER och BOKA_SMTP_PASS.');
  } else if (/ENOTFOUND|EAI_AGAIN/i.test(m)) {
    console.log('        Tolkning: servernamnet går inte att slå upp. Kontrollera BOKA_SMTP_HOST.');
  } else if (/ETIMEDOUT|ECONNREFUSED/i.test(m)) {
    console.log('        Tolkning: ingen kontakt på porten. Kontrollera BOKA_SMTP_PORT och brandvägg.');
  } else if (/550|relay access denied|sender address rejected/i.test(m)) {
    console.log('        Tolkning: servern vägrar skicka för den avsändaradressen.');
  }
}
