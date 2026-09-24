-- Boka tid — databasschema
-- Alla tidpunkter för möten lagras i UTC (timestamptz). Veckoschemat lagras
-- som minuter från midnatt i användarens tidszon, inte som klockslag i UTC,
-- eftersom "alltid 09:00 lokal tid" ska gälla även efter sommartidsskiftet.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  title         TEXT,
  timezone      TEXT NOT NULL DEFAULT 'Europe/Stockholm',
  role          TEXT NOT NULL DEFAULT 'host' CHECK (role IN ('host','admin')),
  password_hash TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Delegerad M365-koppling per användare. Tokens lagras krypterade (AES-256-GCM).
CREATE TABLE IF NOT EXISTS ms_accounts (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ms_upn        TEXT,
  ms_oid        TEXT,
  access_token  TEXT,
  refresh_token TEXT,
  expires_at    TIMESTAMPTZ,
  scopes        TEXT,
  last_error    TEXT,
  connected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_types (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug           TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT,
  duration_min   INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  buffer_before  INTEGER NOT NULL DEFAULT 0 CHECK (buffer_before >= 0),
  buffer_after   INTEGER NOT NULL DEFAULT 0 CHECK (buffer_after >= 0),
  slot_step_min  INTEGER NOT NULL DEFAULT 30 CHECK (slot_step_min BETWEEN 5 AND 240),
  min_notice_min INTEGER NOT NULL DEFAULT 240 CHECK (min_notice_min >= 0),
  max_days_ahead INTEGER NOT NULL DEFAULT 60 CHECK (max_days_ahead BETWEEN 1 AND 365),
  max_per_day    INTEGER,
  location_type  TEXT NOT NULL DEFAULT 'teams'
                 CHECK (location_type IN ('teams','phone','physical','other')),
  location_text  TEXT,
  questions      JSONB NOT NULL DEFAULT '[]'::jsonb,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

-- Veckoschema. weekday: 1 = måndag ... 7 = söndag (ISO).
CREATE TABLE IF NOT EXISTS availability_rules (
  id        SERIAL PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday   INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_min INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1440),
  end_min   INTEGER NOT NULL CHECK (end_min BETWEEN 0 AND 1440),
  CHECK (end_min > start_min)
);

-- Undantag för enskilda datum: antingen helt stängt, eller andra tider än vanligt.
CREATE TABLE IF NOT EXISTS date_overrides (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  on_date     DATE NOT NULL,
  unavailable BOOLEAN NOT NULL DEFAULT TRUE,
  start_min   INTEGER CHECK (start_min BETWEEN 0 AND 1440),
  end_min     INTEGER CHECK (end_min BETWEEN 0 AND 1440),
  note        TEXT,
  UNIQUE (user_id, on_date)
);

CREATE TABLE IF NOT EXISTS bookings (
  id             SERIAL PRIMARY KEY,
  event_type_id  INTEGER NOT NULL REFERENCES event_types(id) ON DELETE RESTRICT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  start_utc      TIMESTAMPTZ NOT NULL,
  end_utc        TIMESTAMPTZ NOT NULL,
  invitee_name   TEXT NOT NULL,
  invitee_email  TEXT NOT NULL,
  invitee_org    TEXT,
  answers        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status         TEXT NOT NULL DEFAULT 'confirmed'
                 CHECK (status IN ('confirmed','cancelled')),
  cancel_token   TEXT UNIQUE NOT NULL,
  graph_event_id TEXT,
  join_url       TEXT,
  ics_uid        TEXT NOT NULL,
  ics_sequence   INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at   TIMESTAMPTZ,
  cancelled_by   TEXT,
  cancel_reason  TEXT,
  CHECK (end_utc > start_utc)
);

-- Hindrar två bekräftade bokningar på exakt samma starttid hos samma värd.
-- Överlapp i övrigt fångas i slotmotorn; det här är sista spärren mot dubbelklick.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_no_double_start
  ON bookings (user_id, start_utc) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_user_span ON bookings (user_id, start_utc, end_utc);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Kortlivat tillstånd för OAuth-flödet mot Entra (CSRF-skydd + PKCE).
CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verifier   TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      BIGSERIAL PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor   TEXT,
  action  TEXT NOT NULL,
  detail  JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at DESC);

-- ---------------------------------------------------------------------------
-- Tillägg som körs vid varje start. Ofarliga att upprepa, och de behövs för att
-- en befintlig databas ska få nya kolumner utan manuell migrering.
-- ---------------------------------------------------------------------------

-- Inloggning med Microsoft: tillståndet skapas innan användaren finns, så
-- user_id måste kunna vara tomt, och vi behöver veta vad flödet ska mynna i.
ALTER TABLE oauth_states ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'connect';

-- Varifrån kontot kom, för granskning och för att veta vem som har lösenord.
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'seed';

-- ---------------------------------------------------------------------------
-- Omröstningar: föreslå flera tider, låt deltagarna svara, besluta en tid.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS polls (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_token   TEXT UNIQUE NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT,
  duration_min   INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  location_type  TEXT NOT NULL DEFAULT 'teams'
                 CHECK (location_type IN ('teams','phone','physical','other')),
  location_text  TEXT,
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','closed','decided','cancelled')),
  deadline       TIMESTAMPTZ,
  hold_calendar  BOOLEAN NOT NULL DEFAULT TRUE,
  hide_names     BOOLEAN NOT NULL DEFAULT FALSE,
  decided_option INTEGER,
  decided_event  TEXT,
  decided_join   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ,
  decided_at     TIMESTAMPTZ
);

-- Ett föreslaget tidsspann. graph_event_id är preliminärbokningen i kalendern.
CREATE TABLE IF NOT EXISTS poll_options (
  id             SERIAL PRIMARY KEY,
  poll_id        INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  start_utc      TIMESTAMPTZ NOT NULL,
  end_utc        TIMESTAMPTZ NOT NULL,
  graph_event_id TEXT,
  hold_error     TEXT,
  UNIQUE (poll_id, start_utc),
  CHECK (end_utc > start_utc)
);

CREATE INDEX IF NOT EXISTS poll_options_span ON poll_options (start_utc, end_utc);

CREATE TABLE IF NOT EXISTS poll_participants (
  id           SERIAL PRIMARY KEY,
  poll_id      INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  org          TEXT,
  token        TEXT UNIQUE NOT NULL,
  invited_at   TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS poll_participants_unik
  ON poll_participants (poll_id, lower(email));

CREATE TABLE IF NOT EXISTS poll_votes (
  id             SERIAL PRIMARY KEY,
  option_id      INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES poll_participants(id) ON DELETE CASCADE,
  answer         TEXT NOT NULL CHECK (answer IN ('ja','kanske','nej')),
  answered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (option_id, participant_id)
);

-- Den beslutade tiden pekar på ett förslag. Läggs som referens i efterhand
-- eftersom polls skapas före poll_options.
ALTER TABLE polls DROP CONSTRAINT IF EXISTS polls_decided_option_fk;
ALTER TABLE polls ADD CONSTRAINT polls_decided_option_fk
  FOREIGN KEY (decided_option) REFERENCES poll_options(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Organisation, gruppbokningar och rollstyrning.
-- ---------------------------------------------------------------------------

-- En rad. id = 1 är alltid organisationen; tabellen finns för att inställningarna
-- ska kunna ändras i drift utan att någon rör .env.
CREATE TABLE IF NOT EXISTS organization (
  id           INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name         TEXT,
  website_url  TEXT,
  logo_file    TEXT,
  theme_color  TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT
);

INSERT INTO organization (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Värdar på en bokningstjänst utöver ägaren. Ägaren (event_types.user_id) är
-- organisatör och den vars kalender mötet skapas i.
CREATE TABLE IF NOT EXISTS event_type_hosts (
  event_type_id INTEGER NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (event_type_id, user_id)
);

-- Alla värdar på en genomförd bokning. Behövs för att en bokad tid ska blockeras
-- för varje värd även när deras M365-kalender inte är kopplad — samma
-- tvålagersskydd som omröstningarnas reservationer har.
CREATE TABLE IF NOT EXISTS booking_hosts (
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (booking_id, user_id)
);

CREATE INDEX IF NOT EXISTS booking_hosts_user ON booking_hosts (user_id);
