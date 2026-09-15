// GET /api/quotes/:id → cotización completa (cliente + líneas) para Ver/Editar/PDF.
const { sql, ok, fail } = require('../_db');
const { requireAuth } = require('../_auth');

module.exports = async (req, res) => {
  try {
    const s = sql();
    await requireAuth(req);
    const id = String(req.query.id || '');
    if (!id) {
      const e = new Error('id requerido');
      e.status = 400;
      throw e;
    }
    const q = await s`
      SELECT q.id, q.number, q.issue_date, q.project, q.status, q.salesperson,
             q.observations, q.signature_png, q.iva_pct, q.neto, q.iva, q.total,
             q.created_at, q.updated_at,
             c.full_name AS cliente, c.company AS empresa, c.contact_name AS contacto,
             c.email, c.phone AS telefono, c.address AS direccion, b.name AS tipo
      FROM quotes q JOIN clients c ON c.id = q.client_id
      LEFT JOIN board_types b ON b.id = q.board_type_id
      WHERE q.id = ${id}`;
    if (!q.length) {
      const e = new Error('cotización no encontrada');
      e.status = 404;
      throw e;
    }
    const lines = await s`
      SELECT l.product_id, l.reference, l.description, l.unit_price, l.quantity,
             cat.name AS categoria
      FROM quote_lines l LEFT JOIN categories cat ON cat.id = l.category_id
      WHERE l.quote_id = ${id} ORDER BY l.line_no`;
    const r = q[0];
    return ok(res, {
      srv_id: r.id, numero: String(r.number), fecha: String(r.issue_date).slice(0, 10),
      cliente: r.cliente || '', empresa: r.empresa || '', contacto: r.contacto || '',
      email: r.email || '', telefono: r.telefono || '', direccion: r.direccion || '',
      proyecto: r.project || '', tipo_tablero: r.tipo || '', estado: r.status,
      vendedor: r.salesperson || '', obs: r.observations || '', firma: r.signature_png || null,
      ivaPct: Number(r.iva_pct), neto: r.neto, iva: r.iva, total: r.total,
      created_at: r.created_at, updated_at: r.updated_at,
      lineas: lines.map(l => ({
        producto_id: l.product_id, referencia: l.reference || '',
        descripcion: l.description, precio_unitario: l.unit_price, cantidad: l.quantity,
        categoria: l.categoria || 'Materiales'
      }))
    });
  } catch (e) {
    fail(res, e);
  }
};
