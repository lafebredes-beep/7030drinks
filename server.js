const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database('./stock7030.db', (err) => {
  if (err) console.error('Error en SQLite:', err.message);
  else console.log('Conectado a SQLite stock7030.db');
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      costo REAL DEFAULT 0,
      precio REAL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      codigo_barras TEXT,
      es_combo INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS combo_detalles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      combo_id INTEGER,
      ingrediente_id INTEGER,
      cantidad INTEGER,
      FOREIGN KEY(combo_id) REFERENCES productos(id) ON DELETE CASCADE,
      FOREIGN KEY(ingrediente_id) REFERENCES productos(id)
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

// --- OBTENER PRODUCTOS (Calculando stock dinámico de combos) ---
app.get('/api/productos', (req, res) => {
  const sqlProductos = `SELECT *, (stock <= 5 AND es_combo = 0) AS alerta_stock FROM productos ORDER BY es_combo ASC, nombre ASC`;
  const sqlCombos = `
    SELECT cd.combo_id, cd.ingrediente_id, cd.cantidad, p.stock AS stock_ingrediente, p.nombre AS nombre_ingrediente
    FROM combo_detalles cd
    JOIN productos p ON cd.ingrediente_id = p.id
  `;

  db.all(sqlProductos, [], (err, productos) => {
    if (err) return res.status(500).json({ error: err.message });

    db.all(sqlCombos, [], (err, detalles) => {
      if (err) return res.status(500).json({ error: err.message });

      const productosProcesados = productos.map(p => {
        if (p.es_combo === 1) {
          const componentes = detalles.filter(d => d.combo_id === p.id);
          if (componentes.length === 0) {
            p.stock = 0;
          } else {
            const maxCombosPosibles = componentes.map(c => Math.floor(c.stock_ingrediente / c.cantidad));
            p.stock = Math.min(...maxCombosPosibles);
          }
          p.alerta_stock = p.stock === 0 ? 1 : 0;
          p.componentes_txt = componentes.map(c => `${c.nombre_ingrediente} (x${c.cantidad})`).join(' + ');
        }
        return p;
      });

      res.json(productosProcesados);
    });
  });
});

// --- CREAR PRODUCTO INDIVIDUAL ---
app.post('/api/productos', (req, res) => {
  const { nombre, costo, precio, stock, codigo_barras } = req.body;
  const sql = `INSERT INTO productos (nombre, costo, precio, stock, codigo_barras, es_combo) VALUES (?, ?, ?, ?, ?, 0)`;
  db.run(sql, [nombre, costo || 0, precio || 0, stock || 0, codigo_barras || ''], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, nombre, costo, precio, stock, codigo_barras });
  });
});

// --- CREAR COMBO DINÁMICO ---
app.post('/api/combos', (req, res) => {
  const { nombre, precio, items } = req.body; // items: [{ ingrediente_id, cantidad }]
  if (!nombre || !precio || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Datos de combo incompletos' });
  }

  const sqlCombo = `INSERT INTO productos (nombre, costo, precio, stock, codigo_barras, es_combo) VALUES (?, 0, ?, 0, '', 1)`;
  db.run(sqlCombo, [nombre, precio], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    const comboId = this.lastID;

    const stmt = db.prepare(`INSERT INTO combo_detalles (combo_id, ingrediente_id, cantidad) VALUES (?, ?, ?)`);
    items.forEach(item => {
      stmt.run(comboId, item.ingrediente_id, item.cantidad);
    });

    stmt.finalize((err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, comboId });
    });
  });
});

// --- IMPORTAR BULK ---
app.post('/api/productos/bulk', (req, res) => {
  const { productos } = req.body;
  if (!Array.isArray(productos) || productos.length === 0) {
    return res.status(400).json({ error: 'Lista de productos no válida' });
  }

  db.serialize(() => {
    const stmt = db.prepare(`INSERT INTO productos (nombre, costo, precio, stock, codigo_barras, es_combo) VALUES (?, ?, ?, ?, ?, 0)`);
    productos.forEach(p => {
      stmt.run(p.nombre, p.costo || 0, p.precio || 0, p.stock || 0, p.codigo_barras || '');
    });
    stmt.finalize((err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Productos importados' });
    });
  });
});

// --- EDITAR PRODUCTO ---
app.put('/api/productos/:id', (req, res) => {
  const { id } = req.params;
  const { nombre, costo, precio, stock, codigo_barras } = req.body;
  const sql = `UPDATE productos SET nombre = ?, costo = ?, precio = ?, stock = ?, codigo_barras = ? WHERE id = ?`;
  db.run(sql, [nombre, costo, precio, stock, codigo_barras, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ updated: this.changes });
  });
});

// --- ELIMINAR PRODUCTO / COMBO ---
app.delete('/api/productos/:id', (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM combo_detalles WHERE combo_id = ?`, [id], () => {
    db.run(`DELETE FROM productos WHERE id = ?`, [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ deleted: this.changes });
    });
  });
});

// --- REGISTRAR VENTA (DESCUENTO AUTOMÁTICO DE INGREDIENTES) ---
app.post('/api/ventas', (req, res) => {
  const { metodo_pago, producto_id, cantidad } = req.body;
  const cantVenta = Number(cantidad) || 1;

  db.get(`SELECT * FROM productos WHERE id = ?`, [producto_id], (err, producto) => {
    if (err || !producto) return res.status(400).json({ error: 'Producto no encontrado' });

    const totalVenta = producto.precio * cantVenta;

    db.run(`INSERT INTO ventas (total, metodo_pago) VALUES (?, ?)`, [totalVenta, metodo_pago || 'EFECTIVO'], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      const ventaId = this.lastID;

      db.run(`INSERT INTO venta_detalles (venta_id, producto_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)`,
        [ventaId, producto_id, cantVenta, producto.precio]
      );

      if (producto.es_combo === 1) {
        // Descontar componentes sueltos
        db.all(`SELECT ingrediente_id, cantidad FROM combo_detalles WHERE combo_id = ?`, [producto_id], (err, componentes) => {
          if (err) return res.status(500).json({ error: err.message });

          componentes.forEach(comp => {
            const descuentaTotal = comp.cantidad * cantVenta;
            db.run(`UPDATE productos SET stock = stock - ? WHERE id = ?`, [descuentaTotal, comp.ingrediente_id]);
          });
          res.json({ success: true, ventaId, total: totalVenta });
        });
      } else {
        // Descontar producto simple
        db.run(`UPDATE productos SET stock = stock - ? WHERE id = ?`, [cantVenta, producto_id], (err) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true, ventaId, total: totalVenta });
        });
      }
    });
  });
});

// --- HISTORIAL VENTAS ---
app.get('/api/ventas', (req, res) => {
  const sql = `
    SELECT v.id, v.fecha, v.total, v.metodo_pago,
      GROUP_CONCAT(p.nombre || ' (x' || vd.cantidad || ')', ', ') AS items_detalle
    FROM ventas v
    LEFT JOIN venta_detalles vd ON v.id = vd.venta_id
    LEFT JOIN productos p ON vd.producto_id = p.id
    GROUP BY v.id ORDER BY v.id DESC
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// --- RESET VENTAS ---
app.delete('/api/ventas/reset', (req, res) => {
  db.serialize(() => {
    db.run(`DELETE FROM venta_detalles`);
    db.run(`DELETE FROM ventas`);
    db.run(`DELETE FROM sqlite_sequence WHERE name='ventas' OR name='venta_detalles'`);
  }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Historial vaciado' });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor en ejecucion en http://localhost:${PORT}`);
});