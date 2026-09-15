// Autenticación y administración de clave con 2FA por SMS.
// GET  /api/auth?action=status          → {setup_required, sms_mode} (público)
// POST /api/auth?action=setup           → {username,password,phone} solo si no hay usuarios (público)
// POST /api/auth?action=login           → {username,password} → {token,username} (público)
// GET  /api/auth?action=me              → usuario actual (auth)
// POST /api/auth?action=logout          → revoca sesión (auth)
// POST /api/auth?action=change-request  → {current_password,new_password} → envía SMS (auth)
// POST /api/auth?action=change-confirm  → {code} aplica cambio (auth)
// POST /api/auth?action=request-reset   → {username} → envía SMS (público, anti-enumeración)
// POST /api/auth?action=verify-reset    → {username,code,new_password} (público)
const { sql, ok, fail, readBody } = require('./_db');
const {
  hashPassword, verifyPassword, sha256, bad, normalizePhone, validPassword,
  requireAuth, createSession, MAX_LOGIN_FAILS, LOCK_MINUTES
} = require('./_auth');
const { smsMode, sendCode, checkCodeRemote } = require('./_sms');

const OTP_TTL_MIN = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_HOUR = 5;

async function checkOtpRate(s, phone) {
  const r = await s`SELECT count(*)::int AS n FROM otp_codes
    WHERE phone = ${phone} AND created_at > now() - interval '1 hour'`;
  if (r[0].n >= OTP_MAX_PER_HOUR) throw bad('Demasiadas solicitudes. Intenta en una hora.', 429);
}

async function latestOtp(s, userId) {
  const r = await s`SELECT * FROM otp_codes
    WHERE user_id = ${userId} AND NOT used AND expires_at > now()
    ORDER BY created_at DESC LIMIT 1`;
  return r[0] || null;
}

async function consumeOtp(s, row, inputCode) {
  if (!row || row.used) throw bad('Código inválido o ya usado.');
  if (new Date(row.expires_at) < new Date()) throw bad('Código expirado. Pide uno nuevo.');
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    await s`UPDATE otp_codes SET used = true WHERE id = ${row.id}`;
    throw bad('Demasiados intentos. Pide un código nuevo.', 429);
  }
  let valid;
  if (smsMode() === 'twilio') {
    valid = await checkCodeRemote(row.phone, inputCode);
  } else {
    valid = sha256(String(inputCode).trim()) === row.code_hash;
  }
  if (!valid) {
    await s`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ${row.id}`;
    throw bad('Código incorrecto.');
  }
  await s`UPDATE otp_codes SET used = true WHERE id = ${row.id}`;
  return row;
}

async function applyNewPassword(s, userId, newHash) {
  await s`UPDATE app_users SET password_hash = ${newHash}, must_change_password = false,
    failed_attempts = 0, locked_until = NULL WHERE id = ${userId}`;
  await s`DELETE FROM sessions WHERE user_id = ${userId}`;
  await s`DELETE FROM otp_codes WHERE user_id = ${userId} AND NOT used`;
}

module.exports = async (req, res) => {
  try {
    const s = sql();
    const action = String((req.query && req.query.action) || '');

    if (req.method === 'GET' && action === 'status') {
      const r = await s`SELECT count(*)::int AS n FROM app_users`;
      return ok(res, { setup_required: r[0].n === 0, sms_mode: smsMode() });
    }

    if (req.method === 'GET' && action === 'me') {
      const u = await requireAuth(req);
      return ok(res, { id: u.id, username: u.username, phone: u.phone });
    }

    if (req.method === 'POST' && action === 'setup') {
      const n = await s`SELECT count(*)::int AS n FROM app_users`;
      if (n[0].n > 0) throw bad('El sistema ya tiene un administrador.', 403);
      const b = await readBody(req);
      const username = String(b.username || '').trim().toLowerCase();
      const phone = normalizePhone(b.phone);
      if (username.length < 3) throw bad('Usuario mínimo 3 caracteres.');
      if (!validPassword(b.password)) throw bad('La clave debe tener al menos 8 caracteres.');
      if (!phone) throw bad('Teléfono inválido. Usa formato +56912345678.');
      const ins = await s`INSERT INTO app_users (username, phone, password_hash)
        VALUES (${username}, ${phone}, ${hashPassword(b.password)}) RETURNING id`;
      const token = await createSession(ins[0].id);
      return ok(res, { token, username });
    }

    if (req.method === 'POST' && action === 'login') {
      const b = await readBody(req);
      const username = String(b.username || '').trim().toLowerCase();
      const rows = await s`SELECT * FROM app_users WHERE lower(username) = ${username} LIMIT 1`;
      const u = rows[0];
      if (u && u.locked_until && new Date(u.locked_until) > new Date()) {
        throw bad('Cuenta bloqueada temporalmente. Intenta en unos minutos.', 429);
      }
      if (!u || !verifyPassword(String(b.password || ''), u.password_hash)) {
        if (u) {
          const fails = (u.failed_attempts || 0) + 1;
          if (fails >= MAX_LOGIN_FAILS) {
            await s`UPDATE app_users SET failed_attempts = ${fails},
              locked_until = now() + (${LOCK_MINUTES} * interval '1 minute') WHERE id = ${u.id}`;
          } else {
            await s`UPDATE app_users SET failed_attempts = ${fails} WHERE id = ${u.id}`;
          }
        }
        throw bad('Usuario o clave incorrectos.', 401);
      }
      await s`UPDATE app_users SET failed_attempts = 0, locked_until = NULL WHERE id = ${u.id}`;
      const token = await createSession(u.id);
      return ok(res, { token, username: u.username, must_change_password: u.must_change_password });
    }

    if (req.method === 'POST' && action === 'logout') {
      const u = await requireAuth(req);
      const h = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      await s`DELETE FROM sessions WHERE token_hash = ${sha256(h[1])}`;
      return ok(res, { ok: true, username: u.username });
    }

    if (req.method === 'POST' && action === 'change-request') {
      const u = await requireAuth(req);
      const b = await readBody(req);
      const me = (await s`SELECT * FROM app_users WHERE id = ${u.id}`)[0];
      if (!verifyPassword(String(b.current_password || ''), me.password_hash)) {
        throw bad('Tu clave actual no es correcta.', 401);
      }
      if (!validPassword(b.new_password)) throw bad('La nueva clave debe tener al menos 8 caracteres.');
      if (String(b.new_password) === String(b.current_password)) throw bad('La nueva clave debe ser distinta.');
      await checkOtpRate(s, me.phone);
      const sent = await sendCode(me.phone);
      await s`INSERT INTO otp_codes (user_id, phone, code_hash, payload, expires_at)
        VALUES (${me.id}, ${me.phone},
                ${sent.mode === 'local' ? sha256(sent.code) : ''},
                ${JSON.stringify({ kind: 'change', new_hash: hashPassword(b.new_password) })},
                now() + (${OTP_TTL_MIN} * interval '1 minute'))`;
      return ok(res, { sent: true, to: me.phone.replace(/(\+\d{2})(\d{2})(\d{3})(\d{3})/, '$1 $2 $3 $4') });
    }

    if (req.method === 'POST' && action === 'change-confirm') {
      const u = await requireAuth(req);
      const b = await readBody(req);
      const row = await latestOtp(s, u.id);
      if (!row || (row.payload && row.payload.kind) !== 'change') throw bad('No hay un cambio pendiente. Pídelo de nuevo.');
      await consumeOtp(s, row, b.code);
      await applyNewPassword(s, u.id, row.payload.new_hash);
      return ok(res, { ok: true });
    }

    if (req.method === 'POST' && action === 'request-reset') {
      const b = await readBody(req);
      const username = String(b.username || '').trim().toLowerCase();
      const rows = await s`SELECT id, phone FROM app_users WHERE lower(username) = ${username} LIMIT 1`;
      // Anti-enumeración: siempre se responde igual.
      if (rows[0]) {
        try {
          await checkOtpRate(s, rows[0].phone);
          const sent = await sendCode(rows[0].phone);
          await s`INSERT INTO otp_codes (user_id, phone, code_hash, payload, expires_at)
            VALUES (${rows[0].id}, ${rows[0].phone},
                    ${sent.mode === 'local' ? sha256(sent.code) : ''},
                    ${JSON.stringify({ kind: 'reset' })},
                    now() + (${OTP_TTL_MIN} * interval '1 minute'))`;
        } catch {
          // Si falla el SMS o el rate limit, igual se responde genérico.
        }
      }
      return ok(res, { sent: true });
    }

    if (req.method === 'POST' && action === 'verify-reset') {
      const b = await readBody(req);
      const username = String(b.username || '').trim().toLowerCase();
      if (!validPassword(b.new_password)) throw bad('La nueva clave debe tener al menos 8 caracteres.');
      const rows = await s`SELECT id FROM app_users WHERE lower(username) = ${username} LIMIT 1`;
      if (!rows[0]) throw bad('Código inválido.');
      const row = await latestOtp(s, rows[0].id);
      if (!row || (row.payload && row.payload.kind) !== 'reset') throw bad('Código inválido o expirado.');
      await consumeOtp(s, row, b.code);
      await applyNewPassword(s, rows[0].id, hashPassword(b.new_password));
      return ok(res, { ok: true });
    }

    const e = new Error('Acción no válida');
    e.status = 404;
    throw e;
  } catch (e) {
    fail(res, e);
  }
};
