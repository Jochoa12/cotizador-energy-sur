// Cotizaciones — los totales SIEMPRE los calcula Postgres (trigger), nunca el frontend.
// GET    /api/quotes?q=&status=&board=&month=   → historial (lineas: [])
// GET    /api/quotes?stats=1&month=YYYY-MM      → + {stats}
// POST   /api/quotes                            → crear (upsert cliente, folio por secuencia)
// PUT    /api/quotes?id=UUID                    → actualizar (reemplaza líneas)
// DELETE /api/quotes?id=UUID                    → eliminar (cascada a líneas)
const { sql, ok, fail, readBody } = require('./_db');
const { requireAuth } = require('./_auth');

const ESTADOS = ['Borrador', 'Enviada', 'Aprobada', 'Rechazada'];

function mapList(r) {
  return {
    srv_id: r.id, numero: String(r.number), fecha: String(r.issue_date).slice(0, 10),
    cliente: r.cliente || '', empresa: r.empresa || '', contacto: r.contacto || '',
    email: r.email || '', telefono: r.telefono || '', direccion: r.direccion || '',
    proyecto: r.project || '', tipo_tablero: r.tipo || '', estado: r.status,
    vendedor: r.salesperson || '', obs: r.observations || '', firma: null,
    ivaPct: Number(r.iva_pct), neto: r.neto, iva: r.iva, total: r.total,
    created_at: r.created_at, updated_at: r.updated_at, lineas: []
  };
}

async function upsertClient(s, c) {
  const name = String((c && c.nombre) || '').trim();
  const company = String((c && c.empresa) || '').trim();
  const contact = String((c && c.contacto) || '').trim();
  const email = String((c && c.email) || '').trim();
  const phone = String((c && c.telefono) || '').trim();
  const address = String((c && c.direccion) || '').trim();
  let rows = [];
  if (email) rows = await s`SELECT id FROM clients WHERE lower(email) = lower(${email}) LIMIT 1`;
  if (!rows.length && name) {
    rows = await s`SELECT id FROM clients WHERE full_name = ${name} AND company = ${company} LIMIT 1`;
  }
  if (rows.length) {
    await s`UPDATE clients SET full_name = ${name}, company = ${company},
      contact_name = ${contact}, email = ${email}, phone = ${phone}, address = ${address}
      WHERE id = ${rows[0].id}`;
    return rows[0].id;
  }
  const ins = await s`INSERT INTO clients (full_name, company, contact_name, email, phone, address)
    VALUES (${name}, ${company}, ${contact}, ${email}, ${phone}, ${address}) RETURNING id`;
  return ins[0].id;
}

async function boardId(s, name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const r = await s`SELECT id FROM board_types WHERE name = ${n} LIMIT 1`;
  return r.length ? r[0].id : null;
}

function cleanLines(lines) {
  return (lines || [])
    .filter(l => l && String(l.descripcion || '').trim() && Math.floor(Number(l.cantidad)) >= 1)
    .map(l => ({
      producto_id: String(l.producto_id || ''),
      referencia: String(l.referencia || '').trim(),
      descripcion: String(l.descripcion || '').trim(),
      precio: Math.max(0, Math.round(Number(l.precio_unitario) || 0)),
      cantidad: Math.floor(Number(l.cantidad) || 0),
      categoria: String(l.categoria || 'Materiales')
    }));
}

async function insertLines(s, qid, lines) {
  if (!lines.length) return;
  const cats = await s`SELECT id, name FROM categories`;
  const catByName = {};
  cats.forEach(r => { catByName[r.name] = r.id; });
  const refs = [...new Set(lines.map(l => l.referencia).filter(r => r && r !== '—'))];
  let byRef = {};
  if (refs.length) {
    const pr = await s`SELECT id, reference FROM products WHERE reference = ANY(${refs})`;
    pr.forEach(r => { if (!byRef[r.reference]) byRef[r.reference] = r.id; });
  }
  const resolved = [];
  for (const l of lines) {
    let pid = null;
    if (l.producto_id) {
      const chk = await s`SELECT id FROM products WHERE id = ${l.producto_id}`;
      if (chk.length) pid = chk[0].id;
    }
    if (!pid) pid = byRef[l.referencia] || null;
    resolved.push({ ...l, pid, catId: catByName[l.categoria] || null });
  }
  await s.transaction(resolved.map((l, i) =>
    s`INSERT INTO quote_lines (quote_id, line_no, product_id, reference, description, unit_price, quantity, category_id)
      VALUES (${qid}, ${i + 1}, ${l.pid}, ${l.referencia}, ${l.descripcion}, ${l.precio}, ${l.cantidad}, ${l.catId})`
  ));
}

async function totals(s, qid) {
  const r = await s`SELECT number, iva_pct, neto, iva, total FROM quotes WHERE id = ${qid}`;
  return {
    numero: String(r[0].number), ivaPct: Number(r[0].iva_pct),
    neto: r[0].neto, iva: r[0].iva, total: r[0].total
  };
}

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

// Inserta la cotización honrando el folio reservado por el cliente (evita
// saltos: un solo número por factura). Si el folio ya existe (colisión real),
// cae a la secuencia. Tras usar un folio explícito se adelanta la secuencia.
async function insertQuote(s, q) {
  const wanted = parseInt(q.numero) || 0;
  if (wanted > 0) {
    try {
      const ins = await s`INSERT INTO quotes
        (number, client_id, project, board_type_id, status, salesperson, observations, signature_png, iva_pct, issue_date)
        VALUES (${String(wanted)}, ${q.clientId}, ${q.proyecto}, ${q.bId}, ${q.estado},
                ${q.vendedor}, ${q.obs}, ${q.firma}, ${q.ivaPct},
                COALESCE(${q.fecha || null}::date, CURRENT_DATE))
        RETURNING id`;
      await s`SELECT setval('quote_number_seq',
        GREATEST((SELECT last_value FROM quote_number_seq), ${wanted}))`;
      return ins[0].id;
    } catch (e) {
      const m = String((e && e.message) || '') + ' ' + String(e && e.code);
      if (!/duplicate|unique|23505/i.test(m)) throw e;
    }
  }
  const ins = await s`INSERT INTO quotes
    (client_id, project, board_type_id, status, salesperson, observations, signature_png, iva_pct, issue_date)
    VALUES (${q.clientId}, ${q.proyecto}, ${q.bId}, ${q.estado},
            ${q.vendedor}, ${q.obs}, ${q.firma}, ${q.ivaPct},
            COALESCE(${q.fecha || null}::date, CURRENT_DATE))
    RETURNING id`;
  return ins[0].id;
}

module.exports = async (req, res) => {
  try {
    const s = sql();
    await requireAuth(req); // historial y guardado exigen sesión

    if (req.method === 'GET') {
      const qq = String(req.query.q || '');
      const st = String(req.query.status || '');
      const bd = String(req.query.board || '');
      const mo = String(req.query.month || '');
      const rows = await s`
        SELECT q.id, q.number, q.issue_date, q.project, q.status, q.salesperson,
               q.observations, q.iva_pct, q.neto, q.iva, q.total, q.created_at, q.updated_at,
               c.full_name AS cliente, c.company AS empresa, c.contact_name AS contacto,
               c.email, c.phone AS telefono, c.address AS direccion, b.name AS tipo
        FROM quotes q JOIN clients c ON c.id = q.client_id
        LEFT JOIN board_types b ON b.id = q.board_type_id
        WHERE (${qq} = '' OR q.number ILIKE '%' || ${qq} || '%'
               OR c.full_name ILIKE '%' || ${qq} || '%'
               OR COALESCE(q.project, '') ILIKE '%' || ${qq} || '%')
          AND (${st} = '' OR q.status = ${st})
          AND (${bd} = '' OR b.name = ${bd})
          AND (${mo} = '' OR to_char(q.issue_date, 'YYYY-MM') = ${mo})
        ORDER BY q.created_at DESC LIMIT 200`;
      const out = { quotes: rows.map(mapList) };
      if (String(req.query.stats || '') === '1') {
        const month = mo || new Date().toISOString().slice(0, 7);
        const st2 = await s`SELECT status, count(*)::int AS n, COALESCE(sum(total), 0)::int AS monto
          FROM quotes WHERE to_char(issue_date, 'YYYY-MM') = ${month} GROUP BY status`;
        out.stats = { month, byStatus: st2 };
      }
      return ok(res, out);
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      const b = await readBody(req);
      const lines = cleanLines(b.lineas);
      if (!String((b.cliente && b.cliente.nombre) || '').trim()) throw bad('cliente requerido');
      if (!lines.length) throw bad('la cotización necesita al menos una línea');
      const estado = ESTADOS.includes(b.estado) ? b.estado : 'Borrador';

      const clientId = await upsertClient(s, b.cliente || {});
      const bId = await boardId(s, b.tipo_tablero);
      const ivaRow = await s`SELECT value FROM app_settings WHERE key = 'iva_pct'`;
      const ivaPct = Number((ivaRow[0] && ivaRow[0].value) || 19);

      let qid;
      if (req.method === 'POST') {
        const fecha = String(b.fecha || '').trim();
        qid = await insertQuote(s, {
          numero: b.numero, clientId, proyecto: String(b.proyecto || ''), bId, estado,
          vendedor: String(b.vendedor || ''), obs: String(b.obs || ''),
          firma: b.firma || null, ivaPct, fecha
        });
        try {
          await insertLines(s, qid, lines);
        } catch (e) {
          await s`DELETE FROM quotes WHERE id = ${qid}`;
          throw e;
        }
      } else {
        qid = String(req.query.id || '');
        if (!qid) throw bad('id requerido');
        const fecha = String(b.fecha || '').trim();
        await s`UPDATE quotes SET client_id = ${clientId}, project = ${String(b.proyecto || '')},
          board_type_id = ${bId}, status = ${estado}, salesperson = ${String(b.vendedor || '')},
          observations = ${String(b.obs || '')},
          signature_png = COALESCE(${b.firma || null}, signature_png),
          issue_date = COALESCE(${fecha || null}::date, issue_date)
          WHERE id = ${qid}`;
        await s`DELETE FROM quote_lines WHERE quote_id = ${qid}`;
        await insertLines(s, qid, lines);
      }
      const t = await totals(s, qid);
      return ok(res, { srv_id: qid, ...t });
    }

    if (req.method === 'DELETE') {
      const qid = String(req.query.id || '');
      if (!qid) throw bad('id requerido');
      await s`DELETE FROM quotes WHERE id = ${qid}`;
      return ok(res, { deleted: true });
    }

    res.setHeader('Allow', 'GET,POST,PUT,DELETE');
    const e = new Error('Método no permitido');
    e.status = 405;
    throw e;
  } catch (e) {
    fail(res, e);
  }
};
