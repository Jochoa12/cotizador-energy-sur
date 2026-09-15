// GET  /api/config → {iva, currency, conditions, company, board_types, categories}
// PUT  /api/config → {iva?, currency?, conditions?, company?{name,address,phone,email}}
// POST /api/config → {scope:'board_type'|'category', name} crear
//                    {scope:'board_type'|'category', id, active} activar/desactivar
const { sql, ok, fail, readBody } = require('./_db');

module.exports = async (req, res) => {
  try {
    const s = sql();

    if (req.method === 'GET') {
      const settings = await s`SELECT key, value FROM app_settings`;
      const kv = {};
      settings.forEach(r => { kv[r.key] = r.value; });
      const comp = await s`SELECT name, address, phone, email, logo_url FROM companies ORDER BY id LIMIT 1`;
      const boards = await s`SELECT id, name, active FROM board_types ORDER BY sort, name`;
      const cats = await s`SELECT id, name, active FROM categories ORDER BY sort, name`;
      return ok(res, {
        iva: Number(kv.iva_pct ?? 19),
        currency: kv.currency || 'CLP',
        conditions: String(kv.conditions || '').split('|').join('\n'),
        company: comp[0] || {},
        board_types: boards.filter(b => b.active).map(b => b.name),
        board_types_all: boards,
        categories: cats.filter(c => c.active).map(c => c.name),
        categories_all: cats
      });
    }

    if (req.method === 'PUT') {
      const b = await readBody(req);
      if (b.iva !== undefined && (Number(b.iva) < 0 || Number(b.iva) > 100)) {
        const e = new Error('IVA debe estar entre 0 y 100');
        e.status = 400;
        throw e;
      }
      if (b.iva !== undefined) {
        await s`INSERT INTO app_settings (key, value) VALUES ('iva_pct', ${String(b.iva)})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      }
      if (b.currency !== undefined) {
        await s`INSERT INTO app_settings (key, value) VALUES ('currency', ${String(b.currency)})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      }
      if (b.conditions !== undefined) {
        const v = String(b.conditions).split('\n').join('|');
        await s`INSERT INTO app_settings (key, value) VALUES ('conditions', ${v})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      }
      if (b.company) {
        const c = b.company;
        await s`INSERT INTO companies (id, name, address, phone, email)
          VALUES (1, ${String(c.name || 'Energy Sur SpA')}, ${String(c.address || '')},
                  ${String(c.phone || '')}, ${String(c.email || '')})
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address,
            phone = EXCLUDED.phone, email = EXCLUDED.email`;
      }
      return ok(res, { updated: true });
    }

    if (req.method === 'POST') {
      const b = await readBody(req);
      const table = b.scope === 'category' ? 'categories' : 'board_types';
      if (b.id && b.active !== undefined) {
        const active = !(b.active === false || b.active === 0 || b.active === '0');
        if (table === 'categories') await s`UPDATE categories SET active = ${active} WHERE id = ${b.id}`;
        else await s`UPDATE board_types SET active = ${active} WHERE id = ${b.id}`;
        return ok(res, { updated: true });
      }
      const name = String(b.name || '').trim();
      if (!name) {
        const e = new Error('name requerido');
        e.status = 400;
        throw e;
      }
      let rows;
      if (table === 'categories') {
        rows = await s`INSERT INTO categories (name) VALUES (${name})
          ON CONFLICT (name) DO NOTHING RETURNING id`;
      } else {
        rows = await s`INSERT INTO board_types (name) VALUES (${name})
          ON CONFLICT (name) DO NOTHING RETURNING id`;
      }
      return ok(res, { id: rows.length ? rows[0].id : null });
    }

    res.setHeader('Allow', 'GET,PUT,POST');
    const e = new Error('Método no permitido');
    e.status = 405;
    throw e;
  } catch (e) {
    fail(res, e);
  }
};
