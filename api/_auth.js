// Auth helpers — servidor solamente.
// Claves: scrypt (Node crypto, sin dependencias). Sesiones: tokens opacos
// (en DB solo SHA256), 12h de vigencia, revocables con logout.
const crypto = require('crypto');
const { sql } = require('./_db');

const SESSION_HOURS = 12;
const MAX_LOGIN_FAILS = 5;
const LOCK_MINUTES = 5;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + h.toString('hex');
}

function verifyPassword(pw, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts[0] !== 'scrypt' || parts.length !== 3) return false;
    const h = crypto.scryptSync(pw, Buffer.from(parts[1], 'hex'), 64);
    return crypto.timingSafeEqual(h, Buffer.from(parts[2], 'hex'));
  } catch {
    return false;
  }
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function newCode() {
  return String(crypto.randomInt(100000, 1000000)); // 6 dígitos
}

function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 128;
}

// Normaliza a E.164 chileno: "9 9826 2366" → "+56998262366"
function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (/^569\d{8}$/.test(d)) return '+' + d;
  if (/^9\d{8}$/.test(d)) return '+56' + d;
  if (/^\+\d{8,15}$/.test(String(raw || '').trim())) return String(raw).trim();
  return null;
}

async function getSessionUser(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return null;
  const s = sql();
  const rows = await s`SELECT u.id, u.username, u.phone
    FROM sessions t JOIN app_users u ON u.id = t.user_id
    WHERE t.token_hash = ${sha256(m[1])} AND t.expires_at > now() LIMIT 1`;
  return rows[0] || null;
}

async function requireAuth(req) {
  const u = await getSessionUser(req);
  if (!u) {
    const e = new Error('No autenticado');
    e.status = 401;
    throw e;
  }
  return u;
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const s = sql();
  await s`INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${sha256(token)}, ${userId}, now() + (${SESSION_HOURS} * interval '1 hour'))`;
  return token;
}

function bad(msg, status) {
  const e = new Error(msg);
  e.status = status || 400;
  return e;
}

module.exports = {
  hashPassword, verifyPassword, sha256, newCode, validPassword, normalizePhone,
  getSessionUser, requireAuth, createSession, bad,
  MAX_LOGIN_FAILS, LOCK_MINUTES
};
