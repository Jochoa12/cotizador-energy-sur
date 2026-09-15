-- ============================================================================
-- Energy Sur SpA · Cotizador — Migración 002: autenticación + 2FA por SMS
-- Aplicar: psql $DATABASE_URL -f db/002_auth.sql
-- Contraseñas: hash scrypt (Node crypto, sin dependencias), jamás plaintext.
-- Sesiones: tokens opacos (se guarda SHA256), expiración 12h, revocables.
-- OTP: 6 dígitos, 10 min vigencia, máx 5 intentos, un solo uso.
--   - Modo twilio: el código lo custodia Twilio Verify (esta tabla audita/limita).
--   - Modo local (dev): se guarda SHA256 del código.
-- Rate limits: login se bloquea 5 min tras 5 fallos; máx 5 OTP/hora por teléfono.
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username              TEXT NOT NULL UNIQUE,
  phone                 TEXT NOT NULL DEFAULT '',
  password_hash         TEXT NOT NULL,
  must_change_password  BOOLEAN NOT NULL DEFAULT FALSE,
  failed_attempts       INTEGER NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_users_username_idx ON app_users (lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS otp_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES app_users(id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL DEFAULT '',
  payload     JSONB NOT NULL DEFAULT '{}',
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_phone_idx ON otp_codes (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS otp_user_idx ON otp_codes (user_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_users_touch ON app_users;
CREATE TRIGGER trg_users_touch BEFORE UPDATE ON app_users
FOR EACH ROW EXECUTE FUNCTION app_touch();

-- Limpieza: sesiones y OTP vencidos/usados (ejecutar periódicamente o al usar)
-- DELETE FROM sessions WHERE expires_at < now();
-- DELETE FROM otp_codes WHERE used OR expires_at < now() - interval '1 day';
