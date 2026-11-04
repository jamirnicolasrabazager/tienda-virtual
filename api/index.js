'use strict';
/**
 * API de "productos en línea" (Express + Vercel Serverless)
 * - Base de datos: PostgreSQL (DATABASE_URL), igual que antes
 * - Imágenes: Supabase Storage (bucket público, URL permanente)
 * - Autenticación: Supabase Auth (el admin se define por correo en ADMIN_EMAILS)
 */
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

// ---------- Configuración (variables de entorno en Vercel) ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'productos';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Cabeceras defensivas sin imponer una CSP incompatible con el HTML legado.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
});

// CORS cerrado por defecto; permite orígenes explícitos mediante CORS_ORIGINS.
const ORIGENES_PERMITIDOS = new Set((process.env.CORS_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean));
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    let host = '';
    try { host = new URL(origin).hostname; } catch (_) { return callback(null, false); }
    const local = /^(localhost|127\.0\.0\.1)$/.test(host);
    callback(null, local || ORIGENES_PERMITIDOS.has(origin));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'], maxAge: 600
}));
app.use(express.json({ limit: '5mb', strict: true }));

// Limitador ligero por instancia. En Vercel serverless es una defensa de primera línea.
const ventanasRate = new Map();
function rateLimit({ ventanaMs = 15 * 60 * 1000, max = 30, mensaje = 'Demasiadas solicitudes. Inténtalo más tarde.' } = {}) {
  return (req, res, next) => {
    const ahora = Date.now();
    const clave = `${req.ip || req.socket.remoteAddress || 'unknown'}:${req.path}`;
    let item = ventanasRate.get(clave);
    if (!item || ahora >= item.hasta) item = { cuenta: 0, hasta: ahora + ventanaMs };
    item.cuenta += 1; ventanasRate.set(clave, item);
    if (ventanasRate.size > 5000) for (const [k, v] of ventanasRate) if (ahora >= v.hasta) ventanasRate.delete(k);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - item.cuenta)));
    if (item.cuenta > max) {
      res.setHeader('Retry-After', String(Math.ceil((item.hasta - ahora) / 1000)));
      return res.status(429).json({ error: mensaje });
    }
    next();
  };
}

// ---------- Utilidades ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const floor2 = n => Math.floor((Number(n) || 0) * 100 + 1e-9) / 100;
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const listaOpc = (txt, tipo = 'normal') => {
  const raw = String(txt || '');
  const partes = tipo === 'talla' && !/[,;|\n]/.test(raw)
    ? raw.trim().split(/\s+/)
    : raw.split(/[,;|\n]+/);
  return [...new Set(partes.map(s => s.trim()).filter(Boolean))];
};

function normalizarTelBO(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('591')) d = d.slice(3);
  return /^[67]\d{7}$/.test(d) ? d : null; // celular boliviano de 8 dígitos
}
function pctValido(v) {
  const n = (v === undefined || v === null || v === '') ? 0 : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new HttpError(400, 'El cashback debe estar entre 0 y 100 %.');
  return r2(n);
}
function idValido(v) {
  const id = parseInt(v, 10);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Identificador inválido.');
  return id;
}

// ---------- Base de datos ----------
function cadenaConexion() {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) return undefined; // permite cargar la función; la petición devolverá un 503 claro
  try {
    const u = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(u.protocol)) return raw;
    u.searchParams.delete('sslmode');
    return u.toString();
  } catch (_) { return raw; }
}
const esLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');
const pool = new Pool({
  connectionString: cadenaConexion(),
  ssl: esLocal ? false : { rejectUnauthorized: false },
  max: Math.max(1, Math.min(10, Number(process.env.PG_POOL_MAX) || 3)),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: true
});
pool.on('error', err => console.error('Error inesperado del pool PostgreSQL:', err.message));

async function inicializarBD() {
  const dbUrl = process.env.DATABASE_URL || '';
  let dbParsed;
  try { dbParsed = new URL(dbUrl); } catch (_) { throw new HttpError(503, 'Servidor sin configurar: DATABASE_URL falta o es inválida.'); }
  if (!['postgres:', 'postgresql:'].includes(dbParsed.protocol)) throw new HttpError(503, 'DATABASE_URL debe ser una conexión PostgreSQL.');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tienda_productos (
      id SERIAL PRIMARY KEY,
      nombre VARCHAR(255),
      precio NUMERIC,
      descripcion TEXT,
      tallas VARCHAR(255),
      colores VARCHAR(255),
      imagen_url TEXT,
      whatsapp VARCHAR(50),
      redes_json TEXT
    )`);
  await pool.query(`ALTER TABLE tienda_productos ADD COLUMN IF NOT EXISTS cashback_pct NUMERIC NOT NULL DEFAULT 0`);
  // Varias imágenes por producto: arreglo JSON de URLs (la primera es la principal; imagen_url se conserva como respaldo)
  await pool.query(`ALTER TABLE tienda_productos ADD COLUMN IF NOT EXISTS imagenes JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query(`ALTER TABLE tienda_productos ADD COLUMN IF NOT EXISTS stock_controlado BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tienda_stock_variantes (
      id SERIAL PRIMARY KEY,
      producto_id INTEGER NOT NULL REFERENCES tienda_productos(id) ON DELETE CASCADE,
      talla VARCHAR(50) NOT NULL DEFAULT '',
      color VARCHAR(50) NOT NULL DEFAULT '',
      cantidad INTEGER NOT NULL DEFAULT 0 CHECK (cantidad >= 0),
      costo_unitario NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (costo_unitario >= 0),
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (producto_id, talla, color)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tienda_config (
      clave VARCHAR(100) PRIMARY KEY,
      valor TEXT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tienda_perfiles (
      user_id UUID PRIMARY KEY,
      email TEXT NOT NULL,
      nombre TEXT,
      telefono TEXT,
      puntos NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (puntos >= 0),
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tienda_pedidos (
      id SERIAL PRIMARY KEY,
      codigo VARCHAR(20) UNIQUE NOT NULL,
      user_id UUID,
      cliente_nombre TEXT NOT NULL,
      cliente_telefono TEXT NOT NULL,
      cliente_nota TEXT,
      items JSONB NOT NULL,
      subtotal NUMERIC(12,2) NOT NULL,
      puntos_usados NUMERIC(12,2) NOT NULL DEFAULT 0,
      total NUMERIC(12,2) NOT NULL,
      cashback NUMERIC(12,2) NOT NULL DEFAULT 0,
      cashback_acreditado BOOLEAN NOT NULL DEFAULT false,
      puntos_devueltos BOOLEAN NOT NULL DEFAULT false,
      referencia_pago TEXT,
      estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tienda_puntos_mov (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL,
      pedido_id INTEGER,
      tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('ganado','canjeado','devolucion','reversa')),
      monto NUMERIC(12,2) NOT NULL,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`ALTER TABLE tienda_pedidos ADD COLUMN IF NOT EXISTS promo_codigo VARCHAR(40)`);
  await pool.query(`ALTER TABLE tienda_pedidos ADD COLUMN IF NOT EXISTS descuento_promo NUMERIC(12,2) NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE tienda_pedidos ADD COLUMN IF NOT EXISTS nota_admin TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE tienda_pedidos ADD COLUMN IF NOT EXISTS imagenes JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query(`ALTER TABLE tienda_pedidos ADD COLUMN IF NOT EXISTS stock_deducido BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE tienda_pedidos ADD COLUMN IF NOT EXISTS stock_reintegrado BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tienda_promociones (
      id SERIAL PRIMARY KEY,
      codigo VARCHAR(40) UNIQUE NOT NULL,
      descripcion VARCHAR(250) NOT NULL DEFAULT '',
      tipo VARCHAR(15) NOT NULL CHECK (tipo IN ('porcentaje','monto')),
      valor NUMERIC(12,2) NOT NULL CHECK (valor > 0),
      minimo NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (minimo >= 0),
      max_usos INTEGER CHECK (max_usos IS NULL OR max_usos > 0),
      usos INTEGER NOT NULL DEFAULT 0 CHECK (usos >= 0),
      activo BOOLEAN NOT NULL DEFAULT true,
      vence_en TIMESTAMPTZ,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pedidos_user ON tienda_pedidos(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mov_user ON tienda_puntos_mov(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pedidos_codigo ON tienda_pedidos(codigo)`);
  await pool.query(`ALTER TABLE tienda_promociones ADD COLUMN IF NOT EXISTS inicia_en TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE tienda_promociones ADD COLUMN IF NOT EXISTS publica BOOLEAN NOT NULL DEFAULT true`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_promociones_activa ON tienda_promociones(activo, inicia_en, vence_en)`);
  // Seguridad: si la base es Supabase, estas tablas quedarían expuestas con la clave pública (anon).
  // Con RLS activado y sin políticas, solo este servidor (conexión directa) puede leerlas o escribirlas.
  for (const t of ['tienda_productos', 'tienda_config', 'tienda_perfiles', 'tienda_pedidos', 'tienda_puntos_mov', 'tienda_promociones', 'tienda_stock_variantes']) {
    await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
  }
}
let dbPromise = null;
function asegurarBD() {
  if (!dbPromise) dbPromise = inicializarBD().catch(err => { dbPromise = null; throw err; });
  return dbPromise;
}
app.use('/api', ah(async (req, res, next) => { await asegurarBD(); next(); }));

// ---------- Supabase ----------
const SB_OPTS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
let _sbAdmin = null;
function verificarEntorno() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(500, 'Servidor sin configurar: faltan variables de entorno de Supabase.');
  }
}
function sbAdmin() { // clave de servicio: solo para Storage y verificar tokens
  verificarEntorno();
  if (!_sbAdmin) _sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SB_OPTS);
  return _sbAdmin;
}
function sbAuth() { // cliente nuevo por operación: evita mezclar sesiones de usuarios
  verificarEntorno();
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, SB_OPTS);
}
function traducirErrorAuth(error) {
  const m = String((error && error.message) || '');
  if (/invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
  if (/email not confirmed/i.test(m)) return 'Debes confirmar tu correo antes de ingresar. Revisa tu bandeja de entrada.';
  if (/password/i.test(m)) return 'La contraseña no cumple los requisitos (mínimo 8 caracteres).';
  if (/rate limit|too many/i.test(m)) return 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.';
  return 'No se pudo completar la operación. Inténtalo de nuevo.';
}

// ---------- Autenticación y roles ----------
async function usuarioDeRequest(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const { data, error } = await sbAdmin().auth.getUser(m[1]);
  if (error || !data || !data.user) return null;
  const u = data.user;
  return {
    id: u.id,
    email: String(u.email || '').toLowerCase(),
    confirmado: !!(u.email_confirmed_at || u.confirmed_at),
    meta: u.user_metadata || {}
  };
}
const esAdmin = u => !!u && u.confirmado && ADMIN_EMAILS.includes(u.email);

const opcional = ah(async (req, res, next) => {
  req.usuario = await usuarioDeRequest(req);
  if (req.headers.authorization && !req.usuario) throw new HttpError(401, 'Tu sesión venció. Vuelve a ingresar.');
  next();
});
const requiereUsuario = ah(async (req, res, next) => {
  const u = await usuarioDeRequest(req);
  if (!u) throw new HttpError(401, 'Inicia sesión para continuar.');
  req.usuario = u; next();
});
const requiereAdmin = ah(async (req, res, next) => {
  const u = await usuarioDeRequest(req);
  if (!u) throw new HttpError(401, 'Inicia sesión para continuar.');
  if (!esAdmin(u)) throw new HttpError(403, 'Acceso restringido a administradores.');
  req.usuario = u; next();
});

async function asegurarPerfil(db, u, extra = {}) {
  await db.query(
    `INSERT INTO tienda_perfiles (user_id, email, nombre, telefono) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email`,
    [u.id, u.email, extra.nombre || (u.meta && u.meta.nombre) || null, extra.telefono || null]
  );
}
function perfilPublico(p) {
  return { nombre: p.nombre || '', telefono: p.telefono || '', puntos: Number(p.puntos) || 0 };
}
async function respuestaSesion(session, user) {
  const u = {
    id: user.id, email: String(user.email || '').toLowerCase(),
    confirmado: !!(user.email_confirmed_at || user.confirmed_at), meta: user.user_metadata || {}
  };
  await asegurarPerfil(pool, u);
  const { rows } = await pool.query('SELECT nombre, telefono, puntos FROM tienda_perfiles WHERE user_id = $1', [u.id]);
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    user: { id: u.id, email: u.email },
    es_admin: esAdmin(u),
    perfil: perfilPublico(rows[0] || {})
  };
}

// ---------- Imágenes (Supabase Storage) ----------
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
let bucketListo = null;
function asegurarBucket() {
  if (!bucketListo) {
    bucketListo = (async () => {
      const { error } = await sbAdmin().storage.createBucket(BUCKET, {
        public: true, fileSizeLimit: 5 * 1024 * 1024, allowedMimeTypes: Object.keys(MIME_EXT)
      });
      if (error && !/already exists|duplicate/i.test(error.message || '')) {
        console.error('Storage bucket:', error.message);
      }
    })().catch(e => { bucketListo = null; throw e; });
  }
  return bucketListo;
}
async function subirImagenDataUri(dataUri) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUri || '');
  if (!m) throw new HttpError(400, 'Formato de imagen no válido (usa JPG, PNG o WEBP).');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3.2 * 1024 * 1024) throw new HttpError(413, 'La imagen es demasiado grande (máximo 3 MB).');
  await asegurarBucket();
  const ruta = `${new Date().getFullYear()}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${MIME_EXT[m[1]]}`;
  const sb = sbAdmin();
  const { error } = await sb.storage.from(BUCKET).upload(ruta, buf, {
    contentType: m[1], cacheControl: '31536000', upsert: false
  });
  if (error) {
    console.error('Storage upload:', error.message);
    throw new HttpError(502, 'No se pudo guardar la imagen en Supabase Storage.');
  }
  return sb.storage.from(BUCKET).getPublicUrl(ruta).data.publicUrl;
}

// =====================================================================
// RUTAS PÚBLICAS
// =====================================================================
app.get('/api/health', ah(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, servicio: 'tienda-api' });
}));
app.get('/api/productos', ah(async (req, res) => {
  const { rows } = await pool.query(`SELECT id, nombre, precio, descripcion, tallas, colores, imagen_url, whatsapp, redes_json, cashback_pct, imagenes FROM tienda_productos ORDER BY id DESC`);
  res.json(rows);
}));

app.get('/api/config', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tienda_config');
  const config = {};
  rows.forEach(r => { config[r.clave] = r.valor; });
  res.json(config);
}));

// ---------- Descarga forzada del QR de pago ----------
// El navegador enlaza aquí con <a download>: al venir del mismo dominio y con "attachment" se descarga
// directo en escritorio y móviles, sin depender de CORS ni del origen real de la imagen.
function urlPublicaSegura(raw) { // solo https y nombres de dominio públicos (evita apuntar a la red interna)
  let u; try { u = new URL(raw); } catch (e) { return null; }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== 'https:') return null;
  if (h === 'localhost' || /\.(localhost|local|internal)$/.test(h)) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return null;
  return u;
}
const EXT_IMG = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

app.get('/api/qr-pago', ah(async (req, res) => {
  const { rows } = await pool.query("SELECT valor FROM tienda_config WHERE clave = 'cfg_qr_pago'");
  const src = rows[0] && rows[0].valor;
  if (!src) throw new HttpError(404, 'Aún no hay un QR de pago configurado.');
  let buf, tipo;
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(src);
  if (m) { tipo = m[1]; buf = Buffer.from(m[2], 'base64'); }
  else {
    const u = urlPublicaSegura(src);
    if (!u) throw new HttpError(404, 'El QR configurado no está disponible.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(u, { signal: ctrl.signal, redirect: 'error', headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' } });
      tipo = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const declarado = Number(r.headers.get('content-length') || 0);
      if (!r.ok || !EXT_IMG[tipo] || declarado > 5 * 1024 * 1024 || !r.body) throw new Error('respuesta no válida');
      const lector = r.body.getReader();
      const partes = [];
      let total = 0;
      while (true) {
        const parte = await lector.read();
        if (parte.done) break;
        total += parte.value.byteLength;
        if (total > 5 * 1024 * 1024) { ctrl.abort(); throw new Error('imagen demasiado grande'); }
        partes.push(Buffer.from(parte.value));
      }
      buf = Buffer.concat(partes, total);
    } catch (e) {
      throw new HttpError(502, 'No se pudo obtener la imagen del QR.');
    } finally { clearTimeout(timer); }
  }
  if (buf.length > 5 * 1024 * 1024) throw new HttpError(502, 'La imagen del QR es demasiado grande.');
  res.setHeader('Content-Type', tipo);
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Content-Disposition', `attachment; filename="qr-pago.${EXT_IMG[tipo]}"`);
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(buf);
}));

// ---------- Cuentas de clientes ----------
app.post('/api/auth/registro', rateLimit({ max: 5, ventanaMs: 60 * 60 * 1000, mensaje: 'Demasiados intentos de registro. Inténtalo más tarde.' }), ah(async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  const nombre = str(req.body.nombre, 120);
  const telefono = req.body.telefono ? normalizarTelBO(req.body.telefono) : null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Correo inválido.');
  if (password.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres.');
  if (nombre.length < 2) throw new HttpError(400, 'Ingresa tu nombre.');
  if (req.body.telefono && !telefono) throw new HttpError(400, 'Teléfono inválido. Usa 8 dígitos (ej: 71234567).');

  const generico = {
    requiereConfirmacion: true,
    mensaje: 'Revisa tu correo para confirmar la cuenta y luego inicia sesión. Si ya tenías cuenta, solo inicia sesión.'
  };
  // Los correos de administrador nunca se registran por aquí (se crean desde el panel de Supabase)
  if (ADMIN_EMAILS.includes(email)) return res.json(generico);

  const { data, error } = await sbAuth().auth.signUp({ email, password, options: { data: { nombre } } });
  if (error) throw new HttpError(400, traducirErrorAuth(error));
  const user = data && data.user;
  // Supabase devuelve un usuario "falso" sin identidades cuando el correo ya existe
  if (!user || (Array.isArray(user.identities) && user.identities.length === 0)) return res.json(generico);

  await asegurarPerfil(pool, {
    id: user.id, email, meta: { nombre }
  }, { nombre, telefono: telefono ? '+591' + telefono : null });

  if (data.session) return res.json(await respuestaSesion(data.session, user));
  res.json(generico);
}));

app.post('/api/auth/login', rateLimit({ max: 10, ventanaMs: 15 * 60 * 1000, mensaje: 'Demasiados intentos de inicio de sesión. Espera unos minutos.' }), ah(async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) throw new HttpError(400, 'Ingresa correo y contraseña.');
  const { data, error } = await sbAuth().auth.signInWithPassword({ email, password });
  if (error || !data || !data.session) throw new HttpError(401, traducirErrorAuth(error));
  res.json(await respuestaSesion(data.session, data.user));
}));

app.post('/api/auth/refresh', rateLimit({ max: 30, ventanaMs: 15 * 60 * 1000 }), ah(async (req, res) => {
  const refresh_token = String(req.body.refresh_token || '');
  if (!refresh_token) throw new HttpError(400, 'Falta el token de renovación.');
  const { data, error } = await sbAuth().auth.refreshSession({ refresh_token });
  if (error || !data || !data.session) throw new HttpError(401, 'Sesión vencida.');
  res.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at
  });
}));

app.get('/api/me', requiereUsuario, ah(async (req, res) => {
  await asegurarPerfil(pool, req.usuario);
  const { rows } = await pool.query('SELECT nombre, telefono, puntos FROM tienda_perfiles WHERE user_id = $1', [req.usuario.id]);
  res.json({
    user: { id: req.usuario.id, email: req.usuario.email },
    es_admin: esAdmin(req.usuario),
    perfil: perfilPublico(rows[0] || {})
  });
}));

// ---------- Validación pública de códigos promocionales ----------
function descuentoPromocion(promo, subtotal) {
  if (!promo || !promo.activo) return 0;
  if (promo.inicia_en && new Date(promo.inicia_en).getTime() > Date.now()) return 0;
  if (promo.vence_en && new Date(promo.vence_en).getTime() <= Date.now()) return 0;
  if (promo.max_usos != null && Number(promo.usos) >= Number(promo.max_usos)) return 0;
  if (subtotal < Number(promo.minimo || 0)) return 0;
  const bruto = promo.tipo === 'porcentaje'
    ? subtotal * Number(promo.valor) / 100
    : Number(promo.valor);
  return r2(Math.max(0, Math.min(subtotal, bruto)));
}

app.get('/api/promociones/validar', rateLimit({ max: 30, ventanaMs: 15 * 60 * 1000 }), ah(async (req, res) => {
  const codigo = str(req.query.codigo, 40).toUpperCase();
  const subtotal = Number(req.query.subtotal);
  if (!/^[A-Z0-9_-]{3,40}$/.test(codigo) || !Number.isFinite(subtotal) || subtotal < 0) {
    throw new HttpError(400, 'Código promocional o subtotal inválido.');
  }
  const { rows: [promo] } = await pool.query(
    'SELECT codigo, descripcion, tipo, valor, minimo, max_usos, usos, activo, inicia_en, vence_en FROM tienda_promociones WHERE codigo = $1', [codigo]);
  if (!promo || !promo.activo) throw new HttpError(404, 'El código promocional no existe o está desactivado.');
  if (promo.inicia_en && new Date(promo.inicia_en).getTime() > Date.now()) {
    throw new HttpError(400, `Esta promoción todavía no está vigente. Comienza el ${new Date(promo.inicia_en).toLocaleString('es-BO')}.`);
  }
  if ((promo.vence_en && new Date(promo.vence_en).getTime() <= Date.now()) ||
      (promo.max_usos != null && Number(promo.usos) >= Number(promo.max_usos))) {
    throw new HttpError(404, 'Esta promoción venció o alcanzó su límite de usos.');
  }
  if (subtotal < Number(promo.minimo || 0)) {
    throw new HttpError(400, `Esta promoción requiere una compra mínima de Bs. ${Number(promo.minimo).toFixed(2)}.`);
  }
  const descuento = descuentoPromocion(promo, subtotal);
  if (descuento <= 0) throw new HttpError(400, 'El código promocional no se puede aplicar a este pedido.');
  res.json({ codigo: promo.codigo, descripcion: promo.descripcion, descuento, tipo: promo.tipo, valor: Number(promo.valor) });
}));

// Promociones visibles para clientes: solo activas, dentro de sus fechas y con cupo disponible.
app.get('/api/promociones', rateLimit({ max: 60, ventanaMs: 15 * 60 * 1000 }), ah(async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  const { rows } = await pool.query(`
    SELECT codigo, descripcion, tipo, valor, minimo, inicia_en, vence_en,
           (inicia_en IS NULL OR inicia_en <= now()) AS disponible,
           CASE WHEN max_usos IS NULL THEN NULL ELSE GREATEST(0, max_usos - usos) END AS usos_restantes
      FROM tienda_promociones
     WHERE activo = true AND publica = true
       AND (vence_en IS NULL OR vence_en > now())
       AND (max_usos IS NULL OR usos < max_usos)
     ORDER BY vence_en ASC NULLS LAST, creado_en DESC LIMIT 100`);
  res.json(rows);
}));

// ---------- Crear pedido (cliente invitado o con cuenta) ----------
function itemsPublicos(items) {
  return (Array.isArray(items) ? items : []).map(({ costo_unitario, costo_total, ...item }) => item);
}
function formatearPedido(p) {
  return {
    id: p.id, codigo: p.codigo, estado: p.estado, creado_en: p.creado_en,
    cliente: { nombre: p.cliente_nombre, telefono: p.cliente_telefono, nota: p.cliente_nota || '' },
    items: itemsPublicos(p.items), subtotal: Number(p.subtotal), puntos_usados: Number(p.puntos_usados),
    promo_codigo: p.promo_codigo || '', descuento_promo: Number(p.descuento_promo || 0),
    total: Number(p.total), cashback: Number(p.cashback), referencia_pago: p.referencia_pago || '',
    imagenes: Array.isArray(p.imagenes) ? p.imagenes : []
  };
}

app.post('/api/pedidos', rateLimit({ max: 20, ventanaMs: 60 * 60 * 1000, mensaje: 'Has realizado demasiados pedidos. Inténtalo más tarde.' }), opcional, ah(async (req, res) => {
  const b = req.body || {};
  const itemsIn = Array.isArray(b.items) ? b.items : [];
  if (!itemsIn.length || itemsIn.length > 50) throw new HttpError(400, 'El carrito está vacío.');
  const cli = b.cliente || {};
  const nombre = str(cli.nombre, 120);
  const tel = normalizarTelBO(cli.telefono);
  if (nombre.length < 2) throw new HttpError(400, 'Ingresa tu nombre completo.');
  if (!tel) throw new HttpError(400, 'Ingresa un celular válido de 8 dígitos (ej: 71234567).');
  const nota = str(cli.nota, 500);
  const referencia = str(b.referencia_pago, 120);
  const promoCodigo = str(b.promo_codigo, 40).toUpperCase();
  if (promoCodigo && !/^[A-Z0-9_-]{3,40}$/.test(promoCodigo)) throw new HttpError(400, 'Código promocional inválido.');
  const puntosSolicitados = r2(Math.max(0, Number(b.puntos) || 0));
  if (puntosSolicitados > 0 && !req.usuario) throw new HttpError(401, 'Inicia sesión para usar tus puntos.');

  // Los precios SIEMPRE se leen de la base de datos (nunca del navegador)
  const ids = itemsIn.map(i => idValido(i && i.id));
  const { rows: prods } = await pool.query(
    'SELECT id, nombre, precio, tallas, colores, cashback_pct, stock_controlado FROM tienda_productos WHERE id = ANY($1::int[])',
    [[...new Set(ids)]]
  );
  const mapa = new Map(prods.map(p => [p.id, p]));
  const lineas = [];
  const cantidadesStock = new Map();
  let subtotal = 0;
  let cashbackBruto = 0;
  for (const it of itemsIn) {
    const p = mapa.get(idValido(it.id));
    if (!p) throw new HttpError(400, 'Un producto del carrito ya no está disponible. Actualiza la página.');
    const cant = parseInt(it.cantidad, 10);
    if (!(cant >= 1 && cant <= 99)) throw new HttpError(400, 'Cantidad inválida en el carrito.');
    const tallasOk = listaOpc(p.tallas, 'talla');
    const coloresOk = listaOpc(p.colores, 'color');
    let talla = str(it.talla, 50);
    let color = str(it.color, 50);
    if (tallasOk.length && !tallasOk.includes(talla)) throw new HttpError(400, `Selecciona una talla válida para "${p.nombre}".`);
    if (coloresOk.length && !coloresOk.includes(color)) throw new HttpError(400, `Selecciona un color válido para "${p.nombre}".`);
    if (!tallasOk.length) talla = '';
    if (!coloresOk.length) color = '';
    const precio = Number(p.precio);
    const sub = r2(precio * cant);
    subtotal += sub;
    cashbackBruto += precio * cant * (Number(p.cashback_pct) || 0) / 100;
    if (p.stock_controlado) {
      const key = `${p.id}|${talla}|${color}`;
      const previo = cantidadesStock.get(key) || { producto_id: p.id, nombre: p.nombre, talla, color, cantidad: 0 };
      previo.cantidad += cant; cantidadesStock.set(key, previo);
    }
    lineas.push({ id: p.id, nombre: p.nombre, precio, cantidad: cant, talla, color, subtotal: sub });
  }
  subtotal = r2(subtotal);
  // Prevalidación de existencias para avisar al cliente antes de generar el pedido.
  // La cantidad se vuelve a comprobar con bloqueo al confirmar el pago.
  for (const v of cantidadesStock.values()) {
    const { rows: [stock] } = await pool.query(
      'SELECT cantidad FROM tienda_stock_variantes WHERE producto_id = $1 AND talla = $2 AND color = $3',
      [v.producto_id, v.talla, v.color]);
    if (!stock || Number(stock.cantidad) < v.cantidad) {
      const disponible = stock ? Number(stock.cantidad) : 0;
      throw new HttpError(409, `Stock insuficiente para ${v.nombre} (${v.talla || 'Sin talla'} / ${v.color || 'Sin color'}). Disponible: ${disponible}.`);
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let descuentoPromo = 0;
    if (promoCodigo) {
      const { rows: [promo] } = await client.query(
        'SELECT * FROM tienda_promociones WHERE codigo = $1 FOR UPDATE', [promoCodigo]);
      descuentoPromo = descuentoPromocion(promo, subtotal);
      if (!promo || descuentoPromo <= 0) throw new HttpError(400, 'El código promocional ya no es válido para este pedido.');
      await client.query('UPDATE tienda_promociones SET usos = usos + 1 WHERE id = $1', [promo.id]);
    }
    let descuento = 0;
    if (req.usuario) {
      await asegurarPerfil(client, req.usuario);
      const { rows: [perf] } = await client.query(
        'SELECT puntos FROM tienda_perfiles WHERE user_id = $1 FOR UPDATE', [req.usuario.id]);
      descuento = r2(Math.min(puntosSolicitados, Number(perf.puntos), Math.max(0, subtotal - descuentoPromo)));
    }
    const total = r2(Math.max(0, subtotal - descuentoPromo - descuento));
    // Los puntos y cupones descuentan la compra, por lo que no generan cashback.
    const cashback = (req.usuario && subtotal > 0) ? floor2(cashbackBruto * (total / subtotal)) : 0;

    let pedido = null;
    for (let i = 0; i < 8 && !pedido; i++) {
      const codigo = 'JG-' + crypto.randomInt(100000, 1000000);
      const r = await client.query(
        `INSERT INTO tienda_pedidos
           (codigo, user_id, cliente_nombre, cliente_telefono, cliente_nota, items,
            subtotal, puntos_usados, promo_codigo, descuento_promo, total, cashback, referencia_pago)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (codigo) DO NOTHING RETURNING *`,
        [codigo, req.usuario ? req.usuario.id : null, nombre, '+591' + tel, nota,
         JSON.stringify(lineas), subtotal, descuento, promoCodigo || null, descuentoPromo, total, cashback, referencia]
      );
      pedido = r.rows[0] || null;
    }
    if (!pedido) throw new HttpError(500, 'No se pudo generar el código del pedido. Inténtalo de nuevo.');

    if (descuento > 0) {
      await client.query('UPDATE tienda_perfiles SET puntos = puntos - $1 WHERE user_id = $2', [descuento, req.usuario.id]);
      await client.query(
        `INSERT INTO tienda_puntos_mov (user_id, pedido_id, tipo, monto) VALUES ($1,$2,'canjeado',$3)`,
        [req.usuario.id, pedido.id, -descuento]);
    }
    await client.query('COMMIT');
    res.status(201).json({ pedido: formatearPedido(pedido) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

// Historial privado del cliente: la consulta se limita siempre al UUID del JWT validado.
app.get('/api/mis-pedidos', requiereUsuario, ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, codigo, estado, creado_en, cliente_nombre, cliente_telefono, cliente_nota,
            items, subtotal, puntos_usados, promo_codigo, descuento_promo, total, cashback,
            referencia_pago, imagenes
       FROM tienda_pedidos WHERE user_id = $1 ORDER BY id DESC LIMIT 100`, [req.usuario.id]);
  res.json(rows.map(formatearPedido));
}));

// Seguimiento protegido por código y últimos cuatro dígitos del teléfono.
// Devuelve solo la información necesaria para consultar el estado del pedido.
app.get('/api/pedidos/seguimiento', rateLimit({ max: 20, ventanaMs: 15 * 60 * 1000 }), ah(async (req, res) => {
  const codigo = str(req.query.codigo, 20).toUpperCase();
  const telefono = String(req.query.telefono || '').replace(/\D/g, '').slice(-4);
  if (!/^JG-\d{6}$/.test(codigo) || !/^\d{4}$/.test(telefono)) {
    throw new HttpError(400, 'Ingresa un código de pedido y los últimos 4 dígitos del celular.');
  }
  const { rows: [p] } = await pool.query(
    `SELECT codigo, estado, creado_en, items, subtotal, puntos_usados, promo_codigo,
            descuento_promo, total, cashback, imagenes, RIGHT(REPLACE(cliente_telefono, '+591', ''), 4) AS telefono_final
       FROM tienda_pedidos WHERE codigo = $1`, [codigo]);
  if (!p || p.telefono_final !== telefono) throw new HttpError(404, 'No encontramos un pedido con esos datos. Verifica el código y el teléfono.');
  res.json({ codigo: p.codigo, estado: p.estado, creado_en: p.creado_en,
    items: itemsPublicos(p.items), subtotal: Number(p.subtotal), puntos_usados: Number(p.puntos_usados),
    promo_codigo: p.promo_codigo || '', descuento_promo: Number(p.descuento_promo || 0),
    total: Number(p.total), cashback: Number(p.cashback), imagenes: Array.isArray(p.imagenes) ? p.imagenes : [] });
}));

// =====================================================================
// RUTAS DE ADMINISTRADOR (JWT de Supabase + correo en ADMIN_EMAILS)
// =====================================================================
app.post('/api/imagenes', rateLimit({ max: 40, ventanaMs: 60 * 60 * 1000 }), requiereAdmin, ah(async (req, res) => {
  const url = await subirImagenDataUri(req.body && req.body.data);
  res.status(201).json({ url });
}));

app.post('/api/productos', requiereAdmin, ah(async (req, res) => {
  const b = req.body || {};
  const nombre = str(b.nombre, 255);
  const precio = Number(b.precio);
  if (!nombre || !Number.isFinite(precio) || precio < 0) throw new HttpError(400, 'Nombre y precio válidos son obligatorios.');
  const cashback = pctValido(b.cashback_pct);
  // Galería: arreglo de URLs (máx. 8). La primera es la imagen principal.
  let imagenes = [];
  if (b.imagenes !== undefined && b.imagenes !== null) {
    if (!Array.isArray(b.imagenes)) throw new HttpError(400, 'El campo "imagenes" debe ser una lista de URLs.');
    if (b.imagenes.length > 8) throw new HttpError(400, 'Máximo 8 imágenes por producto.');
    for (const u of b.imagenes) {
      if (typeof u !== 'string' || u.length > 1000 || !/^https?:\/\/\S+$/i.test(u)) throw new HttpError(400, 'Cada imagen debe ser un enlace http(s) válido.');
      imagenes.push(u);
    }
  }
  let imagen = String(b.imagen_url || '');
  if (imagen.startsWith('data:')) imagen = await subirImagenDataUri(imagen);
  else if (imagen && !/^https?:\/\//i.test(imagen)) imagen = '';
  if (imagenes.length) imagen = imagenes[0];             // imagen_url siempre refleja la principal
  else if (imagen) imagenes = [imagen];
  const redes = b.redes_json && typeof b.redes_json === 'object' ? b.redes_json : {};
  const { rows } = await pool.query(
    `INSERT INTO tienda_productos
       (nombre, precio, descripcion, tallas, colores, imagen_url, whatsapp, redes_json, cashback_pct, imagenes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING id`,
    [nombre, precio, str(b.descripcion, 4000), str(b.tallas, 255), str(b.colores, 255), imagen,
     str(b.whatsapp, 50), JSON.stringify({ fb: str(redes.fb, 500), ig: str(redes.ig, 500) }), cashback,
     JSON.stringify(imagenes)]
  );
  res.status(201).json({ completado: true, id: rows[0].id });
}));

app.put('/api/productos/:id', requiereAdmin, ah(async (req, res) => {
  const id = idValido(req.params.id);
  const b = req.body || {};
  const fields = [];
  const values = [];
  const add = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };
  if (Object.prototype.hasOwnProperty.call(b, 'nombre')) {
    const nombre = str(b.nombre, 255);
    if (!nombre) throw new HttpError(400, 'El nombre del producto no puede quedar vacío.');
    add('nombre', nombre);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'precio')) {
    const precio = Number(b.precio);
    if (!Number.isFinite(precio) || precio < 0) throw new HttpError(400, 'Precio inválido.');
    add('precio', precio);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'descripcion')) add('descripcion', str(b.descripcion, 4000));
  if (Object.prototype.hasOwnProperty.call(b, 'tallas')) add('tallas', str(b.tallas, 255));
  if (Object.prototype.hasOwnProperty.call(b, 'colores')) add('colores', str(b.colores, 255));
  if (Object.prototype.hasOwnProperty.call(b, 'whatsapp')) add('whatsapp', str(b.whatsapp, 50));
  if (Object.prototype.hasOwnProperty.call(b, 'cashback_pct')) add('cashback_pct', pctValido(b.cashback_pct));
  if (Object.prototype.hasOwnProperty.call(b, 'redes_json')) {
    const redes = b.redes_json && typeof b.redes_json === 'object' ? b.redes_json : {};
    add('redes_json', JSON.stringify({ fb: str(redes.fb, 500), ig: str(redes.ig, 500) }));
  }
  if (Object.prototype.hasOwnProperty.call(b, 'imagenes')) {
    if (!Array.isArray(b.imagenes) || b.imagenes.length > 8) throw new HttpError(400, 'La galería debe contener como máximo 8 imágenes.');
    const imagenes = b.imagenes.map(u => {
      if (typeof u !== 'string' || u.length > 1000 || !/^https?:\/\/\S+$/i.test(u)) throw new HttpError(400, 'Cada imagen debe ser una URL HTTP(S) válida.');
      return u;
    });
    add('imagenes', JSON.stringify(imagenes));
    add('imagen_url', imagenes[0] || '');
  }
  if (!fields.length) throw new HttpError(400, 'No se recibieron cambios para guardar.');
  values.push(id);
  const { rowCount } = await pool.query(`UPDATE tienda_productos SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
  if (!rowCount) throw new HttpError(404, 'Producto no encontrado.');
  res.json({ completado: true });
}));

app.delete('/api/productos/:id', requiereAdmin, ah(async (req, res) => {
  await pool.query('DELETE FROM tienda_productos WHERE id = $1', [idValido(req.params.id)]);
  res.json({ completado: true });
}));

app.post('/api/config', requiereAdmin, ah(async (req, res) => {
  const entradas = Object.entries(req.body || {})
    .filter(([k, v]) => /^cfg_[a-z0-9_]{1,60}$/.test(k) && typeof v === 'string' && v.length <= 2000);
  for (const [k, v] of entradas) {
    await pool.query(
      'INSERT INTO tienda_config (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor',
      [k, v]);
  }
  res.json({ completado: true });
}));

// ---------- Inventario por producto, talla y color ----------
app.get('/api/admin/stock', requiereAdmin, ah(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.id, p.nombre, p.precio, p.tallas, p.colores, p.imagen_url, p.imagenes, p.stock_controlado,
      COALESCE(json_agg(json_build_object(
        'talla', s.talla, 'color', s.color, 'cantidad', s.cantidad,
        'costo_unitario', s.costo_unitario, 'actualizado_en', s.actualizado_en
      ) ORDER BY s.talla, s.color) FILTER (WHERE s.id IS NOT NULL), '[]'::json) AS variantes
    FROM tienda_productos p
    LEFT JOIN tienda_stock_variantes s ON s.producto_id = p.id
    GROUP BY p.id ORDER BY p.nombre ASC`);
  res.json(rows.map(p => ({ ...p, stock_controlado: !!p.stock_controlado, variantes: p.variantes || [] })));
}));

app.put('/api/admin/stock/:id', requiereAdmin, ah(async (req, res) => {
  const id = idValido(req.params.id);
  const variantes = Array.isArray(req.body && req.body.variantes) ? req.body.variantes : [];
  if (variantes.length > 300) throw new HttpError(400, 'Demasiadas variantes para un solo producto.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [producto] } = await client.query('SELECT * FROM tienda_productos WHERE id = $1 FOR UPDATE', [id]);
    if (!producto) throw new HttpError(404, 'Producto no encontrado.');
    const tallas = listaOpc(producto.tallas, 'talla');
    const colores = listaOpc(producto.colores, 'color');
    const { rows: antiguas } = await client.query('SELECT talla, color FROM tienda_stock_variantes WHERE producto_id = $1', [id]);
    const clavesAntiguas = new Set(antiguas.map(v => `${String(v.talla || '').toLocaleLowerCase()}|${String(v.color || '').toLocaleLowerCase()}`));
    const normalizadas = [];
    const claves = new Set();
    for (const v of variantes) {
      const talla = str(v.talla, 50);
      const color = str(v.color, 50);
      const cantidad = Number(v.cantidad);
      const costo = Number(v.costo_unitario);
      const key = `${talla.toLocaleLowerCase()}|${color.toLocaleLowerCase()}`;
      const varianteYaRegistrada = clavesAntiguas.has(key);
      const tallaValida = varianteYaRegistrada || (!talla ? !tallas.length : tallas.includes(talla));
      const colorValido = varianteYaRegistrada || (!color ? !colores.length : colores.includes(color));
      if (!tallaValida) throw new HttpError(400, `Talla no válida para ${producto.nombre}.`);
      if (!colorValido) throw new HttpError(400, `Color no válido para ${producto.nombre}.`);
      if (!Number.isInteger(cantidad) || cantidad < 0 || cantidad > 100000) throw new HttpError(400, 'La cantidad debe ser un número entero entre 0 y 100000.');
      if (!Number.isFinite(costo) || costo < 0 || costo > 10000000 || (cantidad > 0 && costo <= 0)) throw new HttpError(400, 'El costo unitario debe ser mayor que 0 cuando hay unidades en stock.');
      if (claves.has(key)) throw new HttpError(400, 'No repitas combinaciones de talla y color.');
      claves.add(key); normalizadas.push({ talla, color, cantidad, costo_unitario: r2(costo) });
    }
    await client.query('DELETE FROM tienda_stock_variantes WHERE producto_id = $1', [id]);
    for (const v of normalizadas) {
      await client.query(`INSERT INTO tienda_stock_variantes (producto_id, talla, color, cantidad, costo_unitario)
        VALUES ($1,$2,$3,$4,$5)`, [id, v.talla, v.color, v.cantidad, v.costo_unitario]);
    }
    await client.query('UPDATE tienda_productos SET stock_controlado = $1 WHERE id = $2', [normalizadas.length > 0, id]);
    await client.query('COMMIT');
    res.json({ completado: true, stock_controlado: normalizadas.length > 0, variantes: normalizadas });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}));

app.get('/api/admin/perfiles', requiereAdmin, ah(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT pf.user_id, pf.email, pf.nombre, pf.telefono, pf.puntos, pf.creado_en,
           COALESCE(c.n, 0)::int AS compras, COALESCE(c.total, 0) AS total_gastado
      FROM tienda_perfiles pf
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS n, SUM(total) AS total
          FROM tienda_pedidos
         WHERE estado IN ('pagado','entregado') AND user_id IS NOT NULL
         GROUP BY user_id
      ) c ON c.user_id = pf.user_id
     ORDER BY pf.creado_en DESC LIMIT 1000`);
  res.json(rows);
}));

app.get('/api/admin/pedidos', requiereAdmin, ah(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.*, pf.email AS usuario_email
      FROM tienda_pedidos p
      LEFT JOIN tienda_perfiles pf ON pf.user_id = p.user_id
     ORDER BY p.id DESC LIMIT 500`);
  res.json(rows);
}));

app.get('/api/admin/puntos', requiereAdmin, ah(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT pf.user_id, pf.email, pf.nombre, pf.puntos,
           COALESCE(SUM(m.monto) FILTER (WHERE m.tipo IN ('ganado','reversa')), 0) AS ganados,
           COALESCE(-SUM(m.monto) FILTER (WHERE m.tipo IN ('canjeado','devolucion')), 0) AS canjeados
      FROM tienda_perfiles pf
      LEFT JOIN tienda_puntos_mov m ON m.user_id = pf.user_id
     GROUP BY pf.user_id
     ORDER BY pf.puntos DESC LIMIT 1000`);
  res.json(rows);
}));

app.get('/api/admin/estadisticas', requiereAdmin, ah(async (req, res) => {
  const { rows: [resumen] } = await pool.query(`
    WITH confirmados AS (
      SELECT p.*,
        COALESCE((SELECT SUM(NULLIF(item->>'costo_total','')::numeric)
                    FROM jsonb_array_elements(p.items) AS item), 0) AS costo_productos,
        EXISTS (SELECT 1 FROM jsonb_array_elements(p.items) AS item
                 WHERE NOT (item ? 'costo_total') OR item->>'costo_total' IS NULL) AS costo_incompleto
      FROM tienda_pedidos p
    )
    SELECT COUNT(*)::int AS pedidos,
      COUNT(*) FILTER (WHERE estado = 'pendiente')::int AS pendientes,
      COUNT(*) FILTER (WHERE estado IN ('pagado','entregado'))::int AS confirmados,
      COUNT(*) FILTER (WHERE estado = 'cancelado')::int AS cancelados,
      COALESCE(SUM(total) FILTER (WHERE estado IN ('pagado','entregado')), 0) AS ingresos,
      COALESCE(AVG(total) FILTER (WHERE estado IN ('pagado','entregado')), 0) AS ticket_promedio,
      COALESCE(SUM(subtotal - costo_productos) FILTER (WHERE NOT costo_incompleto), 0) AS ganancia_bruta,
      COALESCE(SUM(total - cashback - costo_productos) FILTER (WHERE NOT costo_incompleto), 0) AS ganancia_neta,
      COALESCE(SUM(costo_productos) FILTER (WHERE NOT costo_incompleto), 0) AS costo_productos,
      COALESCE(SUM(cashback) FILTER (WHERE NOT costo_incompleto), 0) AS cashback,
      COUNT(*) FILTER (WHERE estado IN ('pagado','entregado') AND costo_incompleto)::int AS pedidos_sin_costo
    FROM confirmados`);
  const { rows: dias } = await pool.query(`
    WITH confirmados AS (
      SELECT p.*,
        COALESCE((SELECT SUM(NULLIF(item->>'costo_total','')::numeric)
                    FROM jsonb_array_elements(p.items) AS item), 0) AS costo_productos,
        EXISTS (SELECT 1 FROM jsonb_array_elements(p.items) AS item
                 WHERE NOT (item ? 'costo_total') OR item->>'costo_total' IS NULL) AS costo_incompleto
      FROM tienda_pedidos p
      WHERE p.estado IN ('pagado','entregado') AND p.creado_en::date >= CURRENT_DATE - INTERVAL '6 days'
    )
    SELECT to_char(dia, 'YYYY-MM-DD') AS fecha,
      COALESCE(SUM(p.total), 0) AS ingresos,
      COALESCE(SUM(p.subtotal - p.costo_productos) FILTER (WHERE NOT p.costo_incompleto), 0) AS ganancia_bruta,
      COALESCE(SUM(p.total - p.cashback - p.costo_productos) FILTER (WHERE NOT p.costo_incompleto), 0) AS ganancia_neta
    FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') AS serie(dia)
    LEFT JOIN confirmados p ON p.creado_en::date = dia::date
    GROUP BY dia ORDER BY dia`);
  res.json({
    ...resumen,
    ingresos: Number(resumen.ingresos), ticket_promedio: Number(resumen.ticket_promedio),
    ganancia_bruta: Number(resumen.ganancia_bruta), ganancia_neta: Number(resumen.ganancia_neta),
    costo_productos: Number(resumen.costo_productos), cashback: Number(resumen.cashback),
    pedidos_sin_costo: Number(resumen.pedidos_sin_costo),
    ventas_por_dia: dias.map(d => ({ fecha: d.fecha, ingresos: Number(d.ingresos), ganancia_bruta: Number(d.ganancia_bruta), ganancia_neta: Number(d.ganancia_neta) }))
  });
}));

app.get('/api/admin/promociones', requiereAdmin, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tienda_promociones ORDER BY creado_en DESC LIMIT 300');
  res.json(rows);
}));
app.post('/api/admin/promociones', requiereAdmin, ah(async (req, res) => {
  const b = req.body || {};
  const codigo = str(b.codigo, 40).toUpperCase();
  const descripcion = str(b.descripcion, 250);
  const tipo = String(b.tipo || '');
  const valor = Number(b.valor);
  const minimo = Number(b.minimo || 0);
  const maxUsos = b.max_usos === '' || b.max_usos == null ? null : Number(b.max_usos);
  const inicia = b.inicia_en ? new Date(b.inicia_en) : null;
  const vence = b.vence_en ? new Date(b.vence_en) : null;
  if (!/^[A-Z0-9_-]{3,40}$/.test(codigo)) throw new HttpError(400, 'El código debe tener entre 3 y 40 caracteres (A-Z, 0-9, guion o guion bajo).');
  if (!['porcentaje','monto'].includes(tipo) || !Number.isFinite(valor) || valor <= 0 || (tipo === 'porcentaje' && valor > 100)) throw new HttpError(400, 'Tipo o valor de promoción inválido.');
  if (!Number.isFinite(minimo) || minimo < 0 || (maxUsos !== null && (!Number.isInteger(maxUsos) || maxUsos < 1))) throw new HttpError(400, 'Compra mínima o límite de usos inválido.');
  if (inicia && !Number.isFinite(inicia.getTime())) throw new HttpError(400, 'Fecha de inicio inválida.');
  if (vence && !Number.isFinite(vence.getTime())) throw new HttpError(400, 'Fecha de vencimiento inválida.');
  if (inicia && vence && vence <= inicia) throw new HttpError(400, 'La fecha de vencimiento debe ser posterior a la fecha de inicio.');
  try {
    const { rows: [promo] } = await pool.query(
      `INSERT INTO tienda_promociones (codigo, descripcion, tipo, valor, minimo, max_usos, activo, inicia_en, vence_en, publica)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [codigo, descripcion, tipo, valor, minimo, maxUsos, b.activo !== false, inicia, vence, b.publica !== false]);
    res.status(201).json(promo);
  } catch (e) { if (e.code === '23505') throw new HttpError(409, 'Ya existe una promoción con ese código.'); throw e; }
}));
app.put('/api/admin/promociones/:id', requiereAdmin, ah(async (req, res) => {
  const id = idValido(req.params.id);
  const activo = req.body && Object.prototype.hasOwnProperty.call(req.body, 'activo') ? req.body.activo === true : null;
  const publica = req.body && Object.prototype.hasOwnProperty.call(req.body, 'publica') ? req.body.publica === true : null;
  const { rowCount } = await pool.query('UPDATE tienda_promociones SET activo = COALESCE($1, activo), publica = COALESCE($2, publica) WHERE id = $3', [activo, publica, id]);
  if (!rowCount) throw new HttpError(404, 'Promoción no encontrada.');
  res.json({ completado: true, activo });
}));
app.delete('/api/admin/promociones/:id', requiereAdmin, ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM tienda_promociones WHERE id = $1', [idValido(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'Promoción no encontrada.');
  res.json({ completado: true });
}));

// Flujo de estados. El cashback se acredita SOLO cuando el administrador confirma el pago.
const TRANSICIONES = {
  pendiente: ['pagado', 'entregado', 'cancelado'],
  pagado: ['entregado', 'cancelado'],
  entregado: ['cancelado'],
  cancelado: []
};

app.patch('/api/admin/pedidos/:id', requiereAdmin, ah(async (req, res) => {
  const id = idValido(req.params.id);
  const b = req.body || {};
  const nuevo = b.estado === undefined ? null : String(b.estado || '');
  if (nuevo !== null && !Object.prototype.hasOwnProperty.call(TRANSICIONES, nuevo)) throw new HttpError(400, 'Estado inválido.');

  const cambios = {};
  if (Object.prototype.hasOwnProperty.call(b, 'cliente_nombre')) {
    const v = str(b.cliente_nombre, 120); if (v.length < 2) throw new HttpError(400, 'El nombre del cliente no es válido.');
    cambios.cliente_nombre = v;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'cliente_telefono')) {
    const v = normalizarTelBO(b.cliente_telefono); if (!v) throw new HttpError(400, 'El teléfono debe tener 8 dígitos válidos.');
    cambios.cliente_telefono = '+591' + v;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'cliente_nota')) cambios.cliente_nota = str(b.cliente_nota, 500);
  if (Object.prototype.hasOwnProperty.call(b, 'referencia_pago')) cambios.referencia_pago = str(b.referencia_pago, 120);
  if (Object.prototype.hasOwnProperty.call(b, 'nota_admin')) cambios.nota_admin = str(b.nota_admin, 1000);
  if (Object.prototype.hasOwnProperty.call(b, 'imagenes')) {
    if (!Array.isArray(b.imagenes) || b.imagenes.length > 8) throw new HttpError(400, 'Se permiten hasta 8 imágenes por pedido.');
    cambios.imagenes = JSON.stringify(b.imagenes.map(u => {
      if (typeof u !== 'string' || u.length > 1000 || !/^https:\/\/\S+$/i.test(u)) throw new HttpError(400, 'Cada imagen adjunta debe ser una URL HTTPS válida.');
      return u;
    }));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [p] } = await client.query('SELECT * FROM tienda_pedidos WHERE id = $1 FOR UPDATE', [id]);
    if (!p) throw new HttpError(404, 'Pedido no encontrado.');
    const estadoFinal = nuevo === null ? p.estado : nuevo;
    if (estadoFinal !== p.estado && !TRANSICIONES[p.estado].includes(estadoFinal)) {
      throw new HttpError(400, `No se puede pasar de "${p.estado}" a "${estadoFinal}".`);
    }

    let acreditado = p.cashback_acreditado;
    let devueltos = p.puntos_devueltos;
    let itemsActualizados = Array.isArray(p.items) ? p.items.map(it => ({ ...it })) : [];
    let stockDeducido = !!p.stock_deducido;
    let stockReintegrado = !!p.stock_reintegrado;

    // Se descuenta el inventario una sola vez cuando se confirma el pago/venta.
    // El paso posterior a "entregado" no vuelve a descontar unidades.
    if (estadoFinal !== p.estado && (estadoFinal === 'pagado' || estadoFinal === 'entregado') && !stockDeducido) {
      for (const item of itemsActualizados) {
        const { rows: [producto] } = await client.query(
          'SELECT stock_controlado FROM tienda_productos WHERE id = $1 FOR SHARE', [idValido(item.id)]);
        if (producto && !producto.stock_controlado) {
          throw new HttpError(409, `Antes de confirmar ${item.nombre}, registra sus unidades y costo en la pestaña Stock / inventario.`);
        }
        if (producto && producto.stock_controlado) {
          const { rows: [v] } = await client.query(
            `SELECT cantidad, costo_unitario FROM tienda_stock_variantes
              WHERE producto_id = $1 AND talla = $2 AND color = $3 FOR UPDATE`,
            [idValido(item.id), str(item.talla, 50), str(item.color, 50)]);
          if (!v) throw new HttpError(409, `No existe stock registrado para ${item.nombre} (${item.talla || 'Sin talla'} / ${item.color || 'Sin color'}).`);
          if (Number(v.cantidad) < Number(item.cantidad)) {
            throw new HttpError(409, `Stock insuficiente para ${item.nombre} (${item.talla || 'Sin talla'} / ${item.color || 'Sin color'}). Disponible: ${v.cantidad}.`);
          }
          const costoUnitario = Number(v.costo_unitario);
          const costoTotal = r2(costoUnitario * Number(item.cantidad));
          await client.query(`UPDATE tienda_stock_variantes SET cantidad = cantidad - $1, actualizado_en = now()
            WHERE producto_id = $2 AND talla = $3 AND color = $4`,
            [Number(item.cantidad), idValido(item.id), str(item.talla, 50), str(item.color, 50)]);
          item.costo_unitario = costoUnitario;
          item.costo_total = costoTotal;
        } else {
          item.costo_unitario = null;
          item.costo_total = null;
        }
      }
      stockDeducido = true;
      stockReintegrado = false;
    }

    // Al cancelar una venta cuyo stock ya se había descontado, las unidades regresan al inventario.
    if (estadoFinal === 'cancelado' && p.estado !== 'cancelado' && stockDeducido && !stockReintegrado) {
      for (const item of itemsActualizados) {
        if (item.costo_unitario !== null && item.costo_unitario !== undefined) {
          const { rowCount: productoExiste } = await client.query('SELECT id FROM tienda_productos WHERE id = $1', [idValido(item.id)]);
          if (!productoExiste) continue;
          await client.query(`INSERT INTO tienda_stock_variantes
              (producto_id, talla, color, cantidad, costo_unitario)
            VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (producto_id, talla, color) DO UPDATE
              SET costo_unitario = CASE
                    WHEN tienda_stock_variantes.cantidad + EXCLUDED.cantidad = 0 THEN EXCLUDED.costo_unitario
                    ELSE round(((tienda_stock_variantes.cantidad * tienda_stock_variantes.costo_unitario) + (EXCLUDED.cantidad * EXCLUDED.costo_unitario)) / (tienda_stock_variantes.cantidad + EXCLUDED.cantidad), 2)
                  END,
                  cantidad = tienda_stock_variantes.cantidad + EXCLUDED.cantidad,
                  actualizado_en = now()`,
            [idValido(item.id), str(item.talla, 50), str(item.color, 50), Number(item.cantidad), Number(item.costo_unitario)]);
        }
      }
      stockReintegrado = true;
    }

    if (estadoFinal !== p.estado && p.user_id) {
      const { rows: [perf] } = await client.query('SELECT puntos FROM tienda_perfiles WHERE user_id = $1 FOR UPDATE', [p.user_id]);
      let saldo = perf ? Number(perf.puntos) : 0;
      if ((estadoFinal === 'pagado' || estadoFinal === 'entregado') && !acreditado && Number(p.cashback) > 0 && perf) {
        const monto = Number(p.cashback); saldo = r2(saldo + monto);
        await client.query('UPDATE tienda_perfiles SET puntos = $1 WHERE user_id = $2', [saldo, p.user_id]);
        await client.query(`INSERT INTO tienda_puntos_mov (user_id, pedido_id, tipo, monto) VALUES ($1,$2,'ganado',$3)`, [p.user_id, p.id, monto]);
        acreditado = true;
      }
      if (estadoFinal === 'cancelado') {
        if (acreditado && perf) {
          const quitar = r2(Math.min(Number(p.cashback), saldo));
          if (quitar > 0) {
            saldo = r2(saldo - quitar);
            await client.query('UPDATE tienda_perfiles SET puntos = $1 WHERE user_id = $2', [saldo, p.user_id]);
            await client.query(`INSERT INTO tienda_puntos_mov (user_id, pedido_id, tipo, monto) VALUES ($1,$2,'reversa',$3)`, [p.user_id, p.id, -quitar]);
          }
          acreditado = false;
        }
        if (!devueltos && Number(p.puntos_usados) > 0 && perf) {
          const monto = Number(p.puntos_usados); saldo = r2(saldo + monto);
          await client.query('UPDATE tienda_perfiles SET puntos = $1 WHERE user_id = $2', [saldo, p.user_id]);
          await client.query(`INSERT INTO tienda_puntos_mov (user_id, pedido_id, tipo, monto) VALUES ($1,$2,'devolucion',$3)`, [p.user_id, p.id, monto]);
          devueltos = true;
        }
      }
    }
    if (estadoFinal === 'cancelado' && p.estado !== 'cancelado' && p.promo_codigo) {
      await client.query('UPDATE tienda_promociones SET usos = GREATEST(0, usos - 1) WHERE codigo = $1', [p.promo_codigo]);
    }
    const sets = ['estado = $1', 'cashback_acreditado = $2', 'puntos_devueltos = $3', 'items = $4::jsonb', 'stock_deducido = $5', 'stock_reintegrado = $6'];
    const vals = [estadoFinal, acreditado, devueltos, JSON.stringify(itemsActualizados), stockDeducido, stockReintegrado];
    for (const [col, val] of Object.entries(cambios)) {
      vals.push(val); sets.push(`${col} = $${vals.length}${col === 'imagenes' ? '::jsonb' : ''}`);
    }
    vals.push(id);
    await client.query(`UPDATE tienda_pedidos SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    await client.query('COMMIT');
    res.json({ completado: true, estado: estadoFinal });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}));

// ---------- Manejo de errores ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'El archivo es demasiado grande.' });
  if (err && err.status && err.status < 500) return res.status(err.status).json({ error: 'Solicitud inválida.' });
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

module.exports = app;

if (require.main === module) { // ejecución local: npm start
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`API local en http://localhost:${port}`));
}
