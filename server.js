const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Asegurar carpeta de backups
const backupsDir = path.join(__dirname, 'backups');
if (!fs.existsSync(backupsDir)) {
  fs.mkdirSync(backupsDir);
}

// Conexión a SQLite
const db = new sqlite3.Database('stock7030.db', (err) => {
  if (err) console.error('Error al conectar a SQLite:', err);
  else console.log('Conectado a SQLite stock7030.db');
});

// Helper para usar async/await con sqlite3
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) reject(err);
    else resolve(this);
  });
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows);
  });
});

// Inicialización de Tablas con Migraciones
db.serialize(() => {
  // Tabla Productos
  db.run(`CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    costo REAL DEFAULT 0,
    precio REAL NOT NULL,
    stock INTEGER DEFAULT 0,
    codigo_barras TEXT,
    es_combo INTEGER DEFAULT 0,
    activo INTEGER DEFAULT 1
  )`);

  // Migraciones por si la tabla ya existía
  db.run("ALTER TABLE productos ADD COLUMN es_combo INTEGER DEFAULT 0", () => {});
  db.run("ALTER TABLE productos ADD COLUMN activo INTEGER DEFAULT 1", () => {});

  // Tabla Combos Items
  db.run(`CREATE TABLE IF NOT EXISTS combo_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    combo_id INTEGER NOT NULL,
    ingrediente_id INTEGER NOT NULL,
    cantidad INTEGER NOT NULL,
    FOREIGN KEY(combo_id) REFERENCES productos(id),
    FOREIGN KEY(ingrediente_id) REFERENCES productos(id)
  )`);

  // Tabla Ventas
  db.run(`CREATE TABLE IF NOT EXISTS ventas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
    metodo_pago TEXT NOT NULL,
    vendedor TEXT DEFAULT 'General',
    total REAL NOT NULL
  )`);

  // Migración para campo vendedor
  db.run("ALTER TABLE ventas ADD COLUMN vendedor TEXT DEFAULT 'General'", () => {});

  // Tabla Ventas Detalle
  db.run(`CREATE TABLE IF NOT EXISTS ventas_detalle (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venta_id INTEGER NOT NULL,
    producto_id INTEGER NOT NULL,
    cantidad INTEGER NOT NULL,
    precio_unitario REAL NOT NULL,
    FOREIGN KEY(venta_id) REFERENCES ventas(id)
  )`);
});

// ==========================================
// RUTAS DE PRODUCTOS Y COMBOS
// ==========================================

// Obtener solo productos activos
app.get('/api/productos', async (req, res) => {
  try {
    const productos = await dbAll(`
      SELECT p.*, 
        CASE 
          WHEN p.es_combo = 0 THEN (p.stock <= 5)
          ELSE 0 
        END as alerta_stock,
        (
          SELECT GROUP_CONCAT(i.nombre || ' x' || ci.cantidad, ', ')
          FROM combo_items ci
          JOIN productos i ON ci.ingrediente_id = i.id
          WHERE ci.combo_id = p.id
        ) as componentes_txt
      FROM productos p
      WHERE p.activo = 1
      ORDER BY p.nombre ASC
    `);
    res.json(productos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crear Producto Suelto (Validación Backend)
app.post('/api/productos', async (req, res) => {
  const { nombre, costo, precio, stock, codigo_barras } = req.body;

  if (!nombre || typeof nombre !== 'string' || !nombre.trim()) {
    return res.status(400).json({ error: 'El nombre del producto es obligatorio.' });
  }
  if (isNaN(precio) || Number(precio) <= 0) {
    return res.status(400).json({ error: 'El precio debe ser un número positivo.' });
  }
  if (isNaN(costo) || Number(costo) < 0 || isNaN(stock) || Number(stock) < 0) {
    return res.status(400).json({ error: 'El costo y stock no pueden ser negativos.' });
  }

  try {
    const result = await dbRun(
      `INSERT INTO productos (nombre, costo, precio, stock, codigo_barras, es_combo, activo) VALUES (?, ?, ?, ?, ?, 0, 1)`,
      [nombre.trim(), Number(costo) || 0, Number(precio), Math.floor(Number(stock)) || 0, codigo_barras || '']
    );
    res.json({ id: result.lastID, message: 'Producto creado correctamente' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Editar Producto
app.put('/api/productos/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, costo, precio, stock, codigo_barras } = req.body;

  if (!nombre || isNaN(precio) || Number(precio) <= 0 || Number(stock) < 0) {
    return res.status(400).json({ error: 'Datos de producto inválidos.' });
  }

  try {
    await dbRun(
      `UPDATE productos SET nombre = ?, costo = ?, precio = ?, stock = ?, codigo_barras = ? WHERE id = ?`,
      [nombre.trim(), Number(costo) || 0, Number(precio), Math.floor(Number(stock)), codigo_barras || '', id]
    );
    res.json({ message: 'Producto actualizado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Carga Masiva (CSV)
app.post('/api/productos/bulk', async (req, res) => {
  const { productos } = req.body;
  if (!Array.isArray(productos) || productos.length === 0) {
    return res.status(400).json({ error: 'Lista de productos no válida' });
  }

  try {
    await dbRun('BEGIN TRANSACTION');
    for (const p of productos) {
      if (p.nombre && Number(p.precio) > 0) {
        await dbRun(
          `INSERT INTO productos (nombre, costo, precio, stock, codigo_barras, es_combo, activo) VALUES (?, ?, ?, ?, ?, 0, 1)`,
          [p.nombre.trim(), Number(p.costo) || 0, Number(p.precio), Math.floor(Number(p.stock)) || 0, p.codigo_barras || '']
        );
      }
    }
    await dbRun('COMMIT');
    res.json({ message: 'Productos importados' });
  } catch (err) {
    await dbRun('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

// Soft Delete de Producto
app.delete('/api/productos/:id', async (req, res) => {
  try {
    await dbRun(`UPDATE productos SET activo = 0 WHERE id = ?`, [req.params.id]);
    res.json({ message: 'Producto desactivado correctamente (Soft Delete)' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crear Combo con Cálculo de Costo Real
app.post('/api/combos', async (req, res) => {
  const { nombre, precio, items } = req.body;

  if (!nombre || isNaN(precio) || Number(precio) <= 0 || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Datos del combo no válidos.' });
  }

  try {
    await dbRun('BEGIN TRANSACTION');

    // Calcular costo real sumando el costo de cada ingrediente
    let costoCalculado = 0;
    for (const item of items) {
      const ing = await dbGet(`SELECT costo FROM productos WHERE id = ?`, [item.ingrediente_id]);
      if (ing) {
        costoCalculado += (ing.costo * Number(item.cantidad));
      }
    }

    const comboResult = await dbRun(
      `INSERT INTO productos (nombre, costo, precio, stock, es_combo, activo) VALUES (?, ?, ?, 0, 1, 1)`,
      [nombre.trim(), costoCalculado, Number(precio)]
    );

    const comboId = comboResult.lastID;

    for (const item of items) {
      await dbRun(
        `INSERT INTO combo_items (combo_id, ingrediente_id, cantidad) VALUES (?, ?, ?)`,
        [comboId, item.ingrediente_id, Number(item.cantidad)]
      );
    }

    await dbRun('COMMIT');
    res.json({ id: comboId, message: 'Combo creado exitosamente' });
  } catch (err) {
    await dbRun('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// RUTAS DE VENTAS (Transacciones + Stock Check)
// ==========================================

app.post('/api/ventas', async (req, res) => {
  const { producto_id, cantidad, metodo_pago, vendedor } = req.body;

  const cant = Math.floor(Number(cantidad));
  const metodosValidos = ['EFECTIVO', 'MERCADO_PAGO', 'TRANSFERENCIA'];

  if (!producto_id || isNaN(cant) || cant <= 0) {
    return res.status(400).json({ error: 'Cantidad o producto no válido.' });
  }
  if (!metodosValidos.includes(metodo_pago)) {
    return res.status(400).json({ error: 'Método de pago no reconocido.' });
  }

  const nombreVendedor = (vendedor && vendedor.trim()) ? vendedor.trim() : 'General';

  try {
    await dbRun('BEGIN TRANSACTION');

    const prod = await dbGet(`SELECT * FROM productos WHERE id = ? AND activo = 1`, [producto_id]);
    if (!prod) {
      await dbRun('ROLLBACK');
      return res.status(404).json({ error: 'El producto seleccionado no existe o está inactivo.' });
    }

    // 1. CHEQUEO DE STOCK Y DESCUENTO
    if (prod.es_combo === 0) {
      // Producto Suelto
      if (prod.stock < cant) {
        await dbRun('ROLLBACK');
        return res.status(400).json({ 
          error: `Stock insuficiente para "${prod.nombre}". Disponible: ${prod.stock}, Solicitado: ${cant}` 
        });
      }
      await dbRun(`UPDATE productos SET stock = stock - ? WHERE id = ?`, [cant, prod.id]);
    } else {
      // Combo: Verificar stock de todos los ingredientes
      const componentes = await dbAll(
        `SELECT ci.cantidad as cant_combo, p.id, p.nombre, p.stock 
         FROM combo_items ci 
         JOIN productos p ON ci.ingrediente_id = p.id 
         WHERE ci.combo_id = ?`,
        [prod.id]
      );

      for (const comp of componentes) {
        const nec = comp.cant_combo * cant;
        if (comp.stock < nec) {
          await dbRun('ROLLBACK');
          return res.status(400).json({ 
            error: `Stock insuficiente del componente "${comp.nombre}" para armar el combo. Disponible: ${comp.stock}, Necesario: ${nec}` 
          });
        }
      }

      // Si todos tienen stock suficiente, descontar
      for (const comp of componentes) {
        const nec = comp.cant_combo * cant;
        await dbRun(`UPDATE productos SET stock = stock - ? WHERE id = ?`, [nec, comp.id]);
      }
    }

    // 2. REGISTRAR VENTA Y DETALLE
    const totalVenta = prod.precio * cant;
    const ventaResult = await dbRun(
      `INSERT INTO ventas (metodo_pago, vendedor, total) VALUES (?, ?, ?)`,
      [metodo_pago, nombreVendedor, totalVenta]
    );

    await dbRun(
      `INSERT INTO ventas_detalle (venta_id, producto_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)`,
      [ventaResult.lastID, prod.id, cant, prod.precio]
    );

    await dbRun('COMMIT');
    res.json({ message: 'Venta registrada con éxito' });

  } catch (err) {
    await dbRun('ROLLBACK');
    res.status(500).json({ error: 'Error al procesar la venta: ' + err.message });
  }
});

// Obtener historial de ventas
app.get('/api/ventas', async (req, res) => {
  try {
    const ventas = await dbAll(`
      SELECT v.id, v.fecha, v.metodo_pago, v.vendedor, v.total,
        GROUP_CONCAT(p.nombre || ' (x' || vd.cantidad || ')', ', ') as items_detalle
      FROM ventas v
      JOIN ventas_detalle vd ON v.id = vd.venta_id
      JOIN productos p ON vd.producto_id = p.id
      GROUP BY v.id
      ORDER BY v.fecha DESC
    `);
    res.json(ventas);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Vaciar Historial con BACKUP SEGURIDAD
app.delete('/api/ventas/reset', async (req, res) => {
  try {
    // 1. Obtener todas las ventas actuales para hacer el backup
    const ventas = await dbAll(`SELECT * FROM ventas`);
    const detalles = await dbAll(`SELECT * FROM ventas_detalle`);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(backupsDir, `backup_ventas_${timestamp}.json`);

    fs.writeFileSync(backupFile, JSON.stringify({ ventas, detalles }, null, 2));

    // 2. Borrar de la DB
    await dbRun('BEGIN TRANSACTION');
    await dbRun('DELETE FROM ventas_detalle');
    await dbRun('DELETE FROM ventas');
    await dbRun('DELETE FROM sqlite_sequence WHERE name="ventas" OR name="ventas_detalle"');
    await dbRun('COMMIT');

    res.json({ message: `Historial vaciado. Se creó una copia de seguridad en: ${backupFile}` });
  } catch (err) {
    await dbRun('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor en ejecución en http://localhost:${PORT}`);
});