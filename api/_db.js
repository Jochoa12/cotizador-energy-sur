// Capa de acceso a Neon — SOLO servidor. DATABASE_URL jamás llega al navegador.
// Las Vercel Functions (api/*.js) usan el driver HTTP (@neondatabase/serverless),
// ideal para serverless: sin conexiones TCP persistentes.
const { neon } = require('@neondatabase/serverless');

function sql() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    const e = new Error('DATABASE_URL no configurada en el servidor');
    e.status = 500;
    throw e;
  }
  return neon(url);
}

function send(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function ok(res, data) {
  send(res, 200, data);
}

function fail(res, e) {
  const code = e && e.status ? e.status : 500;
  send(res, code, { error: (e && e.message) || 'Error interno' });
}

// Vercel ya parsea JSON a req.body; fallback manual por si acaso.
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

module.exports = { sql, send, ok, fail, readBody };
