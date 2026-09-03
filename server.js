const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Conexión a SQLite
const db = new sqlite3.Database('./stock7030.db', (err) => {
  if (err) {
    console.error('Error al conectar a SQLite:', err.message);
  } else {
    console.log('Conectado a la base de datos SQLite stock7030.db');
  }
});

// Crear tablas si no existen
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      costo REAL DEFAULT 0,
      precio REAL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      codigo_barras TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ventas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
      total REAL DEFAULT 0,
      metodo_pago TEXT DEFAULT 'EFECTIVO'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS venta_detalles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venta_id INTEGER,
      producto_id INTEGER,
      cantidad INTEGER,
      precio_unitario REAL,
      FOREIGN KEY(venta_id) REFERENCES ventas(id),
      FOREIGN KEY(producto_id) REFERENCES productos(id)
    )
  `);
});

// --- RUTAS DE PRODUCTOS ---

app.get('/api/productos', (req, res) => {
  const sql = `SELECT *, (stock <= 5) AS alerta_stock FROM productos ORDER BY nombre ASC`;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/productos', (req, res) => {
  const { nombre, costo, precio, stock, codigo_barras } = req.body;
  const sql = `INSERT INTO productos (nombre, costo, precio, stock, codigo_barras) VALUES (?, ?, ?, ?, ?)`;
  db.run(sql, [nombre, costo || 0, precio || 0, stock || 0, codigo_barras || ''], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, nombre, costo, precio, stock, codigo_barras });
  });
});

app.post('/api/productos/bulk', (req, res) => {
  const { productos } = req.body;
  if (!Array.isArray(productos) || productos.length === 0) {
    return res.status(400).json({ error: 'Lista de productos no válida' });
  }

  db.serialize(() => {
    const stmt = db.prepare(`
      INSERT INTO productos (nombre, costo, precio, stock, codigo_barras)
      VALUES (?, ?, ?, ?, ?)
    `);

    productos.forEach(p => {
      stmt.run(p.nombre, p.costo || 0, p.precio || 0, p.stock || 0, p.codigo_barras || '');
    });

    stmt.finalize((err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Productos importados con éxito' });
    });
  });
});

app.put('/api/productos/:id', (req, res) => {
  const { id } = req.params;
  const { nombre, costo, precio, stock, codigo_barras } = req.body;
  const sql = `UPDATE productos SET nombre = ?, costo = ?, precio = ?, stock = ?, codigo_barras = ? WHERE id = ?`;
  db.run(sql, [nombre, costo, precio, stock, codigo_barras, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ updated: this.changes });
  });
});

app.delete('/api/productos/:id', (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM productos WHERE id = ?`, [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ deleted: this.changes });
  });
});

// --- RUTAS DE VENTAS ---

// Registrar nueva venta
app.post('/api/ventas', (req, res) => {
  const { metodo_pago, items, producto_id, cantidad, precio_unitario } = req.body;

  let listaItems = [];
  if (Array.isArray(items) && items.length > 0) {
    listaItems = items;
  } else if (producto_id && cantidad) {
    listaItems = [{ producto_id, cantidad, precio_unitario }];
  } else {
    return res.status(400).json({ error: 'Datos de venta incompletos' });
  }

  let totalVenta = 0;
  listaItems.forEach(item => {
    totalVenta += (Number(item.precio_unitario) || 0) * (Number(item.cantidad) || 1);
  });

  const sqlVenta = `INSERT INTO ventas (total, metodo_pago) VALUES (?, ?)`;

  db.run(sqlVenta, [totalVenta, metodo_pago || 'EFECTIVO'], function(err) {
    if (err) return res.status(500).json({ error: err.message });

    const ventaId = this.lastID;
    let pendientes = listaItems.length;
    let huboError = false;

    listaItems.forEach(item => {
      db.run(
        `INSERT INTO venta_detalles (venta_id, producto_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)`,
        [ventaId, item.producto_id, item.cantidad, item.precio_unitario || 0]
      );

      db.run(
        `UPDATE productos SET stock = stock - ? WHERE id = ?`,
        [item.cantidad, item.producto_id],
        (err) => {
          if (err) huboError = true;
          pendientes--;
          if (pendientes === 0) {
            if (huboError) {
              return res.status(500).json({ error: 'Venta registrada pero con detalles en stock' });
            }
            res.json({ success: true, ventaId, total: totalVenta });
          }
        }
      );
    });
  });
});

// Obtener historial de ventas
app.get('/api/ventas', (req, res) => {
  const sql = `
    SELECT 
      v.id, 
      v.fecha, 
      v.total, 
      v.metodo_pago,
      GROUP_CONCAT(p.nombre || ' (x' || vd.cantidad || ')', ', ') AS items_detalle
    FROM ventas v
    LEFT JOIN venta_detalles vd ON v.id = vd.venta_id
    LEFT JOIN productos p ON vd.producto_id = p.id
    GROUP BY v.id
    ORDER BY v.id DESC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Reiniciar / Vaciar historial de ventas
app.delete('/api/ventas/reset', (req, res) => {
  db.serialize(() => {
    db.run(`DELETE FROM venta_detalles`);
    db.run(`DELETE FROM ventas`);
    db.run(`DELETE FROM sqlite_sequence WHERE name='ventas' OR name='venta_detalles'`);
  }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Historial de ventas reiniciado a cero' });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor iniciado correctamente. Puedes acceder localmente en http://localhost:${PORT}`);
});