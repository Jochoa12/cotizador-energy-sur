// GET    /api/products?q=interruptor      → búsqueda (folding ³→3 + tags)
// GET    /api/products                    → catálogo activo
// GET    /api/products?all=1              → catálogo completo (admin)
// POST   /api/products                    → crear {referencia,descripcion,categoria,precio,unidad,tags}
// PUT    /api/products?id=UUID            → actualizar / activar-desactivar
// DELETE /api/products?id=UUID            → desactivar (soft delete)
const { sql, ok, fail, readBody } = require('./_db');
const { requireAuth } = require('./_auth');

const SELECT = `
  SELECT p.id, p.reference, p.description, c.name AS category,
         p.price, p.unit, p.tags, p.active
  FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

function mapRow(r) {
  return {
    id: r.id, referencia: r.reference, descripcion: r.description,
    categoria: r.category || 'Materiales', precio: r.price,
    unidad: r.unit, tags: r.tags || '', activo: r.active
  };
}

async function categoryId(s, name) {
  const r = await s`SELECT id FROM categories WHERE name = ${String(name || 'Materiales')} LIMIT 1`;
  return r.length ? r[0].id : null;
}

module.exports = async (req, res) => {
  try {
    const s = sql();
    await requireAuth(req); // todo el catálogo exige sesión

    if (req.method === 'GET') {
      const q = String(req.query.q || '').trim();
      let rows;
      if (q) {
        rows = await s`SELECT p.id, p.reference, p.description, c.name AS category,
            p.price, p.unit, p.tags, p.active
          FROM products p LEFT JOIN categories c ON c.id = p.category_id
          WHERE p.active AND p.search_norm LIKE '%' || app_fold(${q}) || '%'
          ORDER BY p.search_norm <-> app_fold(${q}) LIMIT 12`;
      } else if (String(req.query.all || '') === '1') {
        rows = await s`SELECT p.id, p.reference, p.description, c.name AS category,
            p.price, p.unit, p.tags, p.active
          FROM products p LEFT JOIN categories c ON c.id = p.category_id
          ORDER BY p.description`;
      } else {
        rows = await s`SELECT p.id, p.reference, p.description, c.name AS category,
            p.price, p.unit, p.tags, p.active
          FROM products p LEFT JOIN categories c ON c.id = p.category_id
          WHERE p.active ORDER BY p.description`;
      }
      return ok(res, rows.map(mapRow));
    }

    if (req.method === 'POST') {
      const b = await readBody(req);
      const ref = String(b.referencia || '').trim();
      const desc = String(b.descripcion || '').trim();
      const price = Math.max(0, Math.round(Number(b.precio) || 0));
      if (!ref || !desc) {
        const e = new Error('referencia y descripcion son requeridas');
        e.status = 400;
        throw e;
      }
      const catId = await categoryId(s, b.categoria);
      const rows = await s`INSERT INTO products (reference, description, category_id, price, unit, tags)
        VALUES (${ref}, ${desc}, ${catId}, ${price}, ${String(b.unidad || 'c/u')}, ${String(b.tags || '')})
        RETURNING id`;
      return ok(res, { id: rows[0].id });
    }

    if (req.method === 'PUT') {
      const id = String(req.query.id || '');
      if (!id) {
        const e = new Error('id requerido');
        e.status = 400;
        throw e;
      }
      const b = await readBody(req);
      const catId = await categoryId(s, b.categoria);
      await s`UPDATE products SET reference = ${String(b.referencia)},
        description = ${String(b.descripcion)}, category_id = ${catId},
        price = ${Math.max(0, Math.round(Number(b.precio) || 0))},
        unit = ${String(b.unidad || 'c/u')}, tags = ${String(b.tags || '')},
        active = ${b.activo === false || b.activo === 0 || b.activo === '0' ? false : true}
        WHERE id = ${id}`;
      return ok(res, { updated: true });
    }

    if (req.method === 'DELETE') {
      const id = String(req.query.id || '');
      if (!id) {
        const e = new Error('id requerido');
        e.status = 400;
        throw e;
      }
      await s`UPDATE products SET active = false WHERE id = ${id}`;
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
