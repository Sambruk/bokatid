'use strict';
// Superadmin: användare och organisationsinställningar.
// Rollen 'admin' styr åtkomsten; 'host' ser bara sitt eget.

const fs = require('fs');
const path = require('path');
const { q, audit } = require('./db');
const { hashPassword, randomToken } = require('./crypto');
const { tema } = require('./farg');

const MEDIA = path.join(__dirname, '..', 'media');
const LOGO_MAX_BYTES = 1_536_000; // 1500 kB jämnt, så beskedet till användaren blir ett helt tal

// Bara bildformat webbläsare renderar utan att kunna köra skript. SVG lämnas
// medvetet utanför: en SVG kan bära skript och serveras här från samma ursprung.
const BILDTYPER = [
  { ext: 'png', mime: 'image/png', magi: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', mime: 'image/jpeg', magi: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'webp', mime: 'image/webp', magi: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
];

/** Organisationen som den publika sidan behöver den. */
async function publikOrganisation() {
  const { rows } = await q(
    'SELECT name, website_url, logo_file, theme_color, poll_maybe_label FROM organization WHERE id = 1'
  );
  const o = rows[0] || {};
  return {
    name: o.name || null,
    websiteUrl: o.website_url || null,
    logoUrl: o.logo_file ? `media/${o.logo_file}` : null,
    tema: o.theme_color ? tema(o.theme_color) : null,
    // Svarsalternativet mellan ja och nej. Verksamheter uttrycker det olika.
    kanskeText: o.poll_maybe_label || 'Om jag måste',
  };
}

module.exports = function adminRoutes({ router, requireAuth, helpers }) {
  const { bad, str, int, isEmail } = helpers;

  async function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') return bad(res, 403, 'Kräver superadmin');
    next();
  }

  /* ---------- publikt ---------- */

  router.get('/api/organization', async (req, res) => {
    res.json(await publikOrganisation());
  });

  /* ---------- användare ---------- */

  router.get('/api/admin/users', requireAuth, async (req, res) => {
    // Alla inloggade får se listan: den behövs för att välja värdar till en
    // bokningstjänst. Bara superadmin ser e-postadresser och kan ändra något.
    const admin = req.user.role === 'admin';
    const { rows } = await q(
      `SELECT u.id, u.name, u.slug, u.title, u.email, u.role, u.active, u.created_via, u.created_at,
              (SELECT count(*) FROM ms_accounts m WHERE m.user_id = u.id) > 0 AS kalender,
              (SELECT count(*) FROM event_types e WHERE e.user_id = u.id AND e.active) AS tjanster
       FROM users u ORDER BY u.active DESC, u.name`
    );
    res.json({
      admin,
      users: rows.map((u) => ({
        id: u.id,
        name: u.name,
        slug: u.slug,
        title: u.title,
        active: u.active,
        kalender: u.kalender,
        ...(admin
          ? {
              email: u.email,
              role: u.role,
              created_via: u.created_via,
              created_at: u.created_at,
              tjanster: Number(u.tjanster),
            }
          : {}),
      })),
    });
  });

  router.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    const name = str(req.body?.name, 120);
    const email = str(req.body?.email, 254).toLowerCase();
    const slug = rensaSlug(str(req.body?.slug, 60) || email.split('@')[0]);
    if (name.length < 2) return bad(res, 400, 'Ange namn');
    if (!isEmail(email)) return bad(res, 400, 'Ange en giltig e-postadress');
    if (!slug) return bad(res, 400, 'Ange ett kortnamn för bokningsadressen');

    const role = req.body?.role === 'admin' ? 'admin' : 'host';
    // Ett lösenord är valfritt: den som loggar in med Microsoft behöver inget.
    const losenord = str(req.body?.password, 200);
    if (losenord && losenord.length < 12) return bad(res, 400, 'Lösenordet måste vara minst 12 tecken');

    try {
      const { rows } = await q(
        `INSERT INTO users (slug, name, email, title, role, password_hash, created_via)
         VALUES ($1,$2,$3,$4,$5,$6,'admin') RETURNING id, slug`,
        [slug, name, email, str(req.body?.title, 160) || null, role, losenord ? hashPassword(losenord) : null]
      );
      const userId = rows[0].id;

      // Ett rimligt veckoschema, annars syns användaren utan att ha några tider.
      for (const weekday of [1, 2, 3, 4, 5]) {
        await q('INSERT INTO availability_rules (user_id, weekday, start_min, end_min) VALUES ($1,$2,$3,$4)', [
          userId,
          weekday,
          9 * 60,
          16 * 60,
        ]);
      }

      await audit(req.user.email, 'user_created', { userId, slug: rows[0].slug, role, av: 'superadmin' });
      res.status(201).json({ ok: true, id: userId, slug: rows[0].slug });
    } catch (err) {
      if (err.code === '23505') {
        return bad(res, 409, /slug/.test(err.detail || '') ? 'Kortnamnet används redan' : 'E-postadressen finns redan');
      }
      throw err;
    }
  });

  router.put('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
    const id = int(req.params.id);
    const { rows: fanns } = await q('SELECT * FROM users WHERE id = $1', [id]);
    if (!fanns[0]) return bad(res, 404, 'Användaren finns inte');

    const aktiv = req.body?.active !== false;
    const role = req.body?.role === 'admin' ? 'admin' : 'host';

    // Spärr mot utelåsning: den sista superadminen får inte tas bort eller
    // degraderas, och ingen kan avaktivera sig själv.
    if (id === req.user.id && (!aktiv || role !== 'admin')) {
      return bad(res, 409, 'Du kan inte ta bort din egen superadmin-behörighet');
    }
    if (fanns[0].role === 'admin' && (role !== 'admin' || !aktiv)) {
      const { rows: kvar } = await q(
        "SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active AND id <> $1",
        [id]
      );
      if (!kvar[0].n) return bad(res, 409, 'Det måste finnas minst en aktiv superadmin');
    }

    const slug = rensaSlug(str(req.body?.slug, 60) || fanns[0].slug);
    if (!slug) return bad(res, 400, 'Ange ett kortnamn');

    // E-postadressen får ändras, men den styr både inloggning och vart
    // bokningsbesked går. Ändras den måste personen logga in med den nya
    // adressen, även via Microsoft.
    const epost = str(req.body?.email, 254).toLowerCase() || fanns[0].email;
    if (!isEmail(epost)) return bad(res, 400, 'Ange en giltig e-postadress');
    const epostBytt = epost !== fanns[0].email.toLowerCase();

    try {
      const { rows } = await q(
        `UPDATE users SET name = $2, title = $3, slug = $4, role = $5, active = $6, email = $7
         WHERE id = $1 RETURNING id, name, slug, role, active, email`,
        [
          id,
          str(req.body?.name, 120) || fanns[0].name,
          str(req.body?.title, 160) || null,
          slug,
          role,
          aktiv,
          epost,
        ]
      );

      if (epostBytt) {
        const { rows: koppling } = await q('SELECT ms_upn FROM ms_accounts WHERE user_id = $1', [id]);
        await audit(req.user.email, 'user_email_changed', {
          userId: id,
          fran: fanns[0].email,
          till: epost,
          kalenderKopplingKvar: koppling[0]?.ms_upn || null,
        });
      }
      // En avstängd användare ska inte ha kvar en giltig session.
      if (!aktiv) await q('DELETE FROM sessions WHERE user_id = $1', [id]);
      await audit(req.user.email, 'user_updated', { userId: id, role, active: aktiv, epostBytt });
      res.json({ ok: true, user: rows[0], epostBytt });
    } catch (err) {
      if (err.code === '23505') {
        return bad(res, 409, /email/.test(err.detail || '') ? 'E-postadressen används redan' : 'Kortnamnet används redan');
      }
      throw err;
    }
  });

  router.post('/api/admin/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
    const id = int(req.params.id);
    const nytt = str(req.body?.password, 200) || randomToken(9);
    if (nytt.length < 12) return bad(res, 400, 'Lösenordet måste vara minst 12 tecken');
    const { rowCount } = await q('UPDATE users SET password_hash = $2 WHERE id = $1', [id, hashPassword(nytt)]);
    if (!rowCount) return bad(res, 404, 'Användaren finns inte');
    await q('DELETE FROM sessions WHERE user_id = $1', [id]);
    await audit(req.user.email, 'user_password_set', { userId: id });
    // Lösenordet visas en gång för superadmin att lämna vidare.
    res.json({ ok: true, password: nytt });
  });

  /* ---------- organisation ---------- */

  router.get('/api/admin/organization', requireAuth, requireAdmin, async (req, res) => {
    const { rows } = await q('SELECT * FROM organization WHERE id = 1');
    const o = rows[0] || {};
    res.json({
      name: o.name || '',
      website_url: o.website_url || '',
      theme_color: o.theme_color || '',
      poll_maybe_label: o.poll_maybe_label || '',
      logoUrl: o.logo_file ? `media/${o.logo_file}` : null,
      tema: o.theme_color ? tema(o.theme_color) : null,
      updated_at: o.updated_at,
      updated_by: o.updated_by,
    });
  });

  router.put('/api/admin/organization', requireAuth, requireAdmin, async (req, res) => {
    const namn = str(req.body?.name, 120);
    const webb = str(req.body?.website_url, 500);
    const farg = str(req.body?.theme_color, 20);
    const kanske = str(req.body?.poll_maybe_label, 40);

    if (webb && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(webb)) {
      return bad(res, 400, 'Webbadressen måste börja med http:// eller https://');
    }
    let temat = null;
    if (farg) {
      temat = tema(farg);
      if (!temat) return bad(res, 400, 'Färgen måste anges som hexkod, till exempel #58A618');
    }

    await q(
      `UPDATE organization SET name = $1, website_url = $2, theme_color = $3,
         poll_maybe_label = $5, updated_at = now(), updated_by = $4 WHERE id = 1`,
      [namn || null, webb || null, farg || null, req.user.email, kanske || null]
    );
    await audit(req.user.email, 'organization_updated', {
      namn,
      webb,
      farg,
      kanskeText: kanske || null,
      justeradFarg: temat?.justerad,
    });
    res.json({ ok: true, tema: temat });
  });

  router.post('/api/admin/organization/logo', requireAuth, requireAdmin, async (req, res) => {
    const data = String(req.body?.data || '').replace(/^data:[^;]+;base64,/, '');
    if (!data) return bad(res, 400, 'Ingen fil togs emot');

    let buf;
    try {
      buf = Buffer.from(data, 'base64');
    } catch {
      return bad(res, 400, 'Filen kunde inte tolkas');
    }
    if (!buf.length) return bad(res, 400, 'Filen är tom');
    if (buf.length > LOGO_MAX_BYTES) {
      return bad(
        res,
        413,
        `Bilden är för stor (${Math.round(buf.length / 1024)} kB). Högst ${Math.round(LOGO_MAX_BYTES / 1024)} kB.`
      );
    }

    // Filändelsen avgör ingenting: innehållet måste vara det format det utger sig för.
    const typ = BILDTYPER.find((t) => {
      try {
        return t.magi(buf);
      } catch {
        return false;
      }
    });
    if (!typ) return bad(res, 415, 'Bilden måste vara PNG, JPEG eller WebP. SVG stöds inte.');

    fs.mkdirSync(MEDIA, { recursive: true });
    const { rows } = await q('SELECT logo_file FROM organization WHERE id = 1');
    const gammal = rows[0]?.logo_file;

    const filnamn = `logo-${randomToken(6)}.${typ.ext}`;
    fs.writeFileSync(path.join(MEDIA, filnamn), buf);

    await q('UPDATE organization SET logo_file = $1, updated_at = now(), updated_by = $2 WHERE id = 1', [
      filnamn,
      req.user.email,
    ]);

    if (gammal && gammal !== filnamn) {
      try {
        fs.unlinkSync(path.join(MEDIA, gammal));
      } catch {
        /* redan borta */
      }
    }

    await audit(req.user.email, 'organization_logo_uploaded', { filnamn, typ: typ.mime, byte: buf.length });
    res.json({ ok: true, logoUrl: `media/${filnamn}` });
  });

  router.delete('/api/admin/organization/logo', requireAuth, requireAdmin, async (req, res) => {
    const { rows } = await q('SELECT logo_file FROM organization WHERE id = 1');
    if (rows[0]?.logo_file) {
      try {
        fs.unlinkSync(path.join(MEDIA, rows[0].logo_file));
      } catch {
        /* redan borta */
      }
    }
    await q('UPDATE organization SET logo_file = NULL, updated_at = now(), updated_by = $1 WHERE id = 1', [
      req.user.email,
    ]);
    await audit(req.user.email, 'organization_logo_removed', {});
    res.json({ ok: true });
  });

  return { requireAdmin, publikOrganisation };
};

function rensaSlug(v) {
  return String(v || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

module.exports.publikOrganisation = publikOrganisation;
