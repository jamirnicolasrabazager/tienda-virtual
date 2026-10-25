const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const CLAVE_CORRECTA = "JG2026admin";

// Reemplaza la función antigua por esta en api/index.js
function verificarAdmin(req, res, next) {
  const token = req.headers['authorization'];
  // Validamos si la clave es idéntica a la configurada
  if (token === CLAVE_CORRECTA || token === `Bearer ${CLAVE_CORRECTA}`) {
    next();
  } else {
    res.status(401).json({ error: "Acceso denegado. Contraseña incorrecta." });
  }
}
async function inicializarBD() {
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
    );
    CREATE TABLE IF NOT EXISTS tienda_config (
      clave VARCHAR(100) PRIMARY KEY,
      valor TEXT
    );
  `);
}
inicializarBD().catch(console.error);

app.get('/api/productos', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM tienda_productos ORDER BY id DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/config', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM tienda_config');
    const config = {};
    rows.forEach(r => config[r.clave] = r.valor);
    res.json(config);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/login', (req, res) => {
  const { clave } = req.body;
  if (clave === CLAVE_CORRECTA) res.json({ valido: true, token: CLAVE_CORRECTA });
  else res.status(401).json({ valido: false, error: "Clave inválida" });
});

app.post('/api/productos', verificarAdmin, async (req, res) => {
  try {
    const { nombre, precio, descripcion, tallas, colores, imagen_url, whatsapp, redes_json } = req.body;
    await pool.query(
      'INSERT INTO tienda_productos (nombre, precio, descripcion, tallas, colores, imagen_url, whatsapp, redes_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [nombre, precio, descripcion, tallas, colores, imagen_url, whatsapp, JSON.stringify(redes_json)]
    );
    res.json({ completado: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/productos/:id', verificarAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM tienda_productos WHERE id = $1', [req.params.id]);
    res.json({ completado: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/config', verificarAdmin, async (req, res) => {
  try {
    const configs = req.body;
    for (const [key, val] of Object.entries(configs)) {
      await pool.query('INSERT INTO tienda_config (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = $2', [key, val]);
    }
    res.json({ completado: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = app;
