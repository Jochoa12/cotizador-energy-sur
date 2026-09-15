-- ============================================================================
-- Energy Sur SpA · Cotizador — Esquema Neon (Serverless Postgres)
-- Proyecto Neon sugerido: cotizador-energy-sur (branch: main / dev)
-- Aplicar: psql $DATABASE_URL -f db/schema.sql
--         o pegar en el SQL Editor del dashboard de Neon
-- Regla de negocio (idéntica al frontend, calculada EN EL SERVIDOR):
--   linea  = unit_price × quantity        (INTEGER, CLP sin decimales)
--   neto   = Σ lineas
--   iva    = round(neto × iva_pct / 100)
--   total  = neto + iva
-- Ejemplo §31: 35500×2 + 50000 + 23000 → neto 144000, iva 27360, total 171360
-- ============================================================================

-- Extensiones (permitidas en Neon)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- Folding de búsqueda (punto 6 del requerimiento):
-- insensible a acentos + pliega super/subíndices (³→3, ₂→2) + minúsculas.
-- "LEX³/ITM 3X40A" se indexa como "lex3 itm 3x40a" → buscar "LEX3" lo encuentra.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_fold(t TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(
    lower(unaccent(translate(
      COALESCE($1,''),
      '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎·ªº',
      '0123456789+-=()0123456789+-=() ao'
    ))),
    '[^a-z0-9+ ]', ' ', 'g')
$$;

-- updated_at automático
CREATE OR REPLACE FUNCTION app_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- ============================================================================
-- PANTALLA Admin → Configuración
-- ============================================================================
CREATE TABLE IF NOT EXISTS companies (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT 'Energy Sur SpA',
  address     TEXT NOT NULL DEFAULT 'Lote 5 Parcela #35 – Lipingue, Los Lagos – Chile',
  phone       TEXT NOT NULL DEFAULT '+56 9 4438 6090',
  email       TEXT NOT NULL DEFAULT 'mariocastillorubilar@gmail.com',
  logo_url    TEXT NOT NULL DEFAULT 'images/logo.png',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Settings clave-valor: iva_pct (parametrizable, NO hardcodeado), currency, conditions
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- PANTALLA Admin → Tipos de tablero (selector de "Datos de la cotización")
-- ============================================================================
CREATE TABLE IF NOT EXISTS board_types (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- PANTALLA Admin → Categorías (Materiales / Accesorios / Servicios, ampliable)
-- ============================================================================
CREATE TABLE IF NOT EXISTS categories (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- PANTALLA Admin → Catálogo  +  PANTALLA Nueva cotización → buscador
-- Producto: id · referencia · descripcion · categoria · precio · unidad · activo
-- + tags (sinónimos: "interruptor" → ITM/DIF) y search_norm pre-calculada.
-- ============================================================================
CREATE TABLE IF NOT EXISTS products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference     TEXT NOT NULL,
  description   TEXT NOT NULL,
  category_id   INTEGER REFERENCES categories(id),
  price         INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),   -- CLP, sin formato
  unit          TEXT NOT NULL DEFAULT 'c/u',
  tags          TEXT NOT NULL DEFAULT '',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  search_norm   TEXT GENERATED ALWAYS AS (
                  app_fold(reference || ' ' || description || ' ' ||
                            COALESCE(tags,''))
                ) STORED,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_search_trgm ON products USING gin (search_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS products_reference_idx ON products (reference);
CREATE INDEX IF NOT EXISTS products_active_idx ON products (active) WHERE active;

-- ============================================================================
-- PANTALLA Nueva cotización → Datos de la cotización (formulario cliente)
-- La API hace UPSERT de cliente al guardar (match por email, si no por nombre).
-- ============================================================================
CREATE TABLE IF NOT EXISTS clients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name     TEXT NOT NULL,                 -- Cliente / Mandante *
  company       TEXT NOT NULL DEFAULT '',
  contact_name  TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clients_email_idx ON clients (email);
CREATE INDEX IF NOT EXISTS clients_name_idx ON clients (full_name);

-- Secuencia de folios (continúa el correlativo del Excel: parte en 110326)
CREATE SEQUENCE IF NOT EXISTS quote_number_seq START 110326;

-- ============================================================================
-- PANTALLAS Nueva cotización + Cotizaciones (historial)
-- iva_pct se CONGELA por cotización (si el IVA cambia mañana, el historial no).
-- neto/iva/total los recalcula el trigger (nunca se confía en el frontend).
-- ============================================================================
CREATE TABLE IF NOT EXISTS quotes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number        TEXT NOT NULL UNIQUE DEFAULT nextval('quote_number_seq')::TEXT,
  issue_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  client_id     UUID NOT NULL REFERENCES clients(id),
  project       TEXT NOT NULL DEFAULT '',
  board_type_id INTEGER REFERENCES board_types(id),
  status        TEXT NOT NULL DEFAULT 'Borrador'
                CHECK (status IN ('Borrador','Enviada','Aprobada','Rechazada')),
  salesperson   TEXT NOT NULL DEFAULT 'Mario Castillo Rubilar',
  observations  TEXT NOT NULL DEFAULT '',
  signature_png TEXT,                            -- dataURL (Fase 2: Neon Object Storage)
  iva_pct       NUMERIC(5,2) NOT NULL DEFAULT 19,
  neto          INTEGER NOT NULL DEFAULT 0 CHECK (neto >= 0),
  iva           INTEGER NOT NULL DEFAULT 0 CHECK (iva >= 0),
  total         INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quotes_totals_consistent CHECK (total = neto + iva)
);
CREATE INDEX IF NOT EXISTS quotes_number_idx ON quotes (number);
CREATE INDEX IF NOT EXISTS quotes_status_idx ON quotes (status);
CREATE INDEX IF NOT EXISTS quotes_date_idx ON quotes (issue_date);
CREATE INDEX IF NOT EXISTS quotes_client_idx ON quotes (client_id);

-- ============================================================================
-- PANTALLA Nueva cotización → Tabla de cotización (detalle)
-- product_id NULL = concepto manual (montaje, accesorios con valor propio).
-- ============================================================================
CREATE TABLE IF NOT EXISTS quote_lines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id      UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  line_no       INTEGER NOT NULL DEFAULT 1,
  product_id    UUID REFERENCES products(id) ON DELETE SET NULL,
  reference     TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL,
  unit_price    INTEGER NOT NULL CHECK (unit_price >= 0),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  line_total    INTEGER GENERATED ALWAYS AS (unit_price * quantity) STORED,
  category_id   INTEGER REFERENCES categories(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (quote_id, line_no)
);
CREATE INDEX IF NOT EXISTS quote_lines_quote_idx ON quote_lines (quote_id);

-- Recálculo servidor (fuente de verdad de Neto/IVA/Total)
CREATE OR REPLACE FUNCTION recalc_quote_totals()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE q UUID; n INT; r NUMERIC(5,2);
BEGIN
  q := COALESCE(NEW.quote_id, OLD.quote_id);
  SELECT COALESCE(SUM(line_total),0) INTO n FROM quote_lines WHERE quote_id = q;
  SELECT iva_pct INTO r FROM quotes WHERE id = q;
  UPDATE quotes SET neto = n,
                    iva  = round(n * r / 100)::INT,
                    total = n + round(n * r / 100)::INT
    WHERE id = q;
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS trg_quote_lines_totals ON quote_lines;
CREATE TRIGGER trg_quote_lines_totals
AFTER INSERT OR UPDATE OR DELETE ON quote_lines
FOR EACH ROW EXECUTE FUNCTION recalc_quote_totals();

-- updated_at en tablas principales
DROP TRIGGER IF EXISTS trg_companies_touch ON companies;
CREATE TRIGGER trg_companies_touch BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION app_touch();
DROP TRIGGER IF EXISTS trg_products_touch ON products;
CREATE TRIGGER trg_products_touch BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION app_touch();
DROP TRIGGER IF EXISTS trg_clients_touch ON clients;
CREATE TRIGGER trg_clients_touch BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION app_touch();
DROP TRIGGER IF EXISTS trg_quotes_touch ON quotes;
CREATE TRIGGER trg_quotes_touch BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION app_touch();

-- ============================================================================
-- SEED (datos iniciales = planilla Excel, misma fuente del catálogo demo)
-- ============================================================================
INSERT INTO companies (name) VALUES ('Energy Sur SpA')
ON CONFLICT DO NOTHING;

INSERT INTO app_settings (key, value) VALUES
  ('iva_pct', '19'),
  ('currency', 'CLP'),
  ('conditions', 'Validez oferta: 15 días.|Forma de pago: 50% anticipo, saldo contra entrega.|Plazo de fabricación: a convenir según proyecto.|Garantía: 12 meses por defectos de fabricación.|Precios en pesos chilenos, IVA incluido en total.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO board_types (name, sort) VALUES
  ('TDF Y A - CD',1),('TDF Y A - CA',2),('TDF Y A - AC',3),('TD AUX, FYA-GE',4),
  ('TDA Domiciliario',5),('TTA Transferencia',6),('TG General',7),('Otro',8)
ON CONFLICT (name) DO NOTHING;

INSERT INTO categories (name, sort) VALUES
  ('Materiales',1),('Accesorios',2),('Servicios',3)
ON CONFLICT (name) DO NOTHING;

-- Catálogo Excel (reference, description, category, price, unit, tags)
INSERT INTO products (reference, description, category_id, price, unit, tags)
SELECT v.reference, v.description, c.id, v.price, v.unit, v.tags FROM (VALUES
  ('409258','LEX³/ITM 3X40A DX³C-10/16KA','Materiales',50000,'c/u','interruptor termomagnetico automatico trifasico riel din'),
  ('004886','LEX/REPART.TETR125A 86X44X105M','Materiales',23000,'c/u','repartidor tetrapolar distribucion barras'),
  ('407670','LEX3/ITM 1X16A DX3C-6/10KA','Materiales',12450,'c/u','interruptor termomagnetico automatico monofasico enchufe alumbrado'),
  ('411504','LEX3/INT.DIF.2X 25A 30MA-AC DX','Materiales',35500,'c/u','interruptor diferencial protector 30ma seguridad personas'),
  ('407668','LEX³/ITM 1X10A DX³C-6/10KA','Materiales',32650,'c/u','interruptor termomagnetico automatico monofasico alumbrado 10a'),
  ('407861','LEX³/ITM 3X25A DX³C-6/10KA','Materiales',15450,'c/u','interruptor termomagnetico automatico trifasico fuerza 25a'),
  ('412501','LEX³/CONTACTOR 2P25A 2NA S CX3','Materiales',35740,'c/u','contactor bobina mando motor 25a'),
  ('024141','OSM/PILOTO MONOBLOC ROJO 220V','Materiales',43750,'c/u','piloto luz señalizacion rojo tablero puerta'),
  ('005814','LEX/PORTAFUSIBLE UNIP.32A/400','Materiales',56870,'c/u','portafusible fusible proteccion unipolar'),
  ('25780','Accesorios de Conexión','Accesorios',25780,'gl','accesorios conexion terminales cables peine borneras'),
  ('34520','Montaje tablero','Servicios',34520,'gl','montaje servicio mano de obra armado instalacion'),
  ('15760','Caja Metálica 800x600x250','Materiales',15760,'c/u','caja metalica gabinete cofre tablero'),
  ('—','Ingeniería / Certificación SEC TE1','Servicios',120000,'gl','ingenieria certificacion sec te1 proyecto memoria plano'),
  ('—','Transporte / Instalación en terreno','Servicios',45000,'gl','transporte instalacion flete terreno visita')
) AS v(reference, description, cat, price, unit, tags)
JOIN categories c ON c.name = v.cat
WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.reference = v.reference AND p.description = v.description);

-- ============================================================================
-- QUERIES DE REFERENCIA (lo que consumirá cada pantalla vía API)
-- Buscador:  SELECT id, reference, description, price FROM products
--             WHERE active AND search_norm LIKE '%' || app_fold($1) || '%'
--             ORDER BY ... LIMIT 12;
--   (mejor con trigramas: ORDER BY search_norm <-> app_fold($1) para ranking)
-- Historial: SELECT q.number, q.issue_date, c.full_name, q.project,
--              b.name AS board, q.neto, q.total, q.status
--             FROM quotes q JOIN clients c ON c.id=q.client_id
--             LEFT JOIN board_types b ON b.id=q.board_type_id
--             WHERE ... ORDER BY q.created_at DESC;
-- Dashboard: SELECT status, count(*), sum(total) FROM quotes
--             WHERE issue_date >= date_trunc('month', now()) GROUP BY status;
-- ============================================================================
-- FASE 2 (no incluir aún): Neon Auth (Better Auth) + RLS por rol
-- (Administrador/Vendedor). Fase 1: acceso servicio vía Vercel Functions,
-- DATABASE_URL solo como variable de entorno del servidor, jamás en el HTML.
-- ============================================================================
