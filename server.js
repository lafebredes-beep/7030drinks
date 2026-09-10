require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Asegurar existencia del directorio de backups
const backupsDir = path.join(__dirname, 'backups');
if (!fs.existsSync(backupsDir)) {
  fs.mkdirSync(backupsDir, { recursive: true });
}

// Conexión a Turso (Nube) o Base de datos local
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:stock7030.db',
  authToken: process.env.TURSO_AUTH_TOKEN
});

// Funciones auxiliares para queries
const dbRun = async (sql, params = []) => {
  const res = await db.execute({ sql, args: params });
  return { lastID: Number(res.lastInsertRowid) };
};
const dbGet = async (sql, params = []) => {
  const res = await db.execute({ sql, args: params });
  return res.rows[0];
};
const dbAll = async (sql, params = []) => {
  const res = await db.execute({ sql, args: params });
  return res.rows;
};

// Inicialización de la Base de Datos
(async () => {
  try {
    await dbRun(`CREATE TABLE IF NOT EXISTS productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL,
      costo REAL DEFAULT 0, precio REAL NOT NULL, stock INTEGER DEFAULT 0,
      codigo_barras TEXT, es_combo INTEGER DEFAULT 0, activo INTEGER DEFAULT 1
    )`);
    try { await dbRun("ALTER TABLE productos ADD COLUMN es_combo INTEGER DEFAULT 0"); } catch (e) {}
    try { await dbRun("ALTER TABLE productos ADD COLUMN activo INTEGER DEFAULT 1"); } catch (e) {}

    await dbRun(`CREATE TABLE IF NOT EXISTS combo_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, combo_id INTEGER NOT NULL,
      ingrediente_id INTEGER NOT NULL, cantidad INTEGER NOT NULL,
      FOREIGN KEY(combo_id) REFERENCES productos(id), FOREIGN KEY(ingrediente_id) REFERENCES productos(id)
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS ventas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
      metodo_pago TEXT NOT NULL, vendedor TEXT DEFAULT 'General', total REAL NOT NULL
    )`);
    try { await dbRun("ALTER TABLE ventas ADD COLUMN vendedor TEXT DEFAULT 'General'"); } catch (e) {}

    await dbRun(`CREATE TABLE IF NOT EXISTS ventas_detalle (
      id INTEGER PRIMARY KEY AUTOINCREMENT, venta_id INTEGER NOT NULL,
      producto_id INTEGER NOT NULL, cantidad INTEGER NOT NULL, precio_unitario REAL NOT NULL,
      FOREIGN KEY(venta_id) REFERENCES ventas(id)
    )`);
    console.log("Conectado a la Base de Datos exitosamente.");
  } catch (err) {
    console.error("Error inicializando tablas:", err);
  }
})();

// ================= RUTAS DE PRODUCTOS =================
app.get('/api/productos', async (req, res) => {
  try {
    const productos = await dbAll(`
      SELECT p.*, 
        CASE WHEN p.es_combo = 0 THEN (p.stock <= 5) ELSE 0 END as alerta_stock,
        (SELECT GROUP_CONCAT(i.nombre || ' x' || ci.cantidad, ', ') FROM combo_items ci JOIN productos i ON ci.ingrediente_id = i.id WHERE ci.combo_id = p.id) as componentes_txt
      FROM productos p WHERE p.activo = 1 ORDER BY p.nombre ASC
    `);
    res.json(productos);
  } catch (err) { res.status(500).json({ error: 'Error al obtener productos.' }); }
});

app.post('/api/productos', async (req, res) => {
  const { nombre, costo, precio, stock, codigo_barras } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  if (isNaN(precio) || Number(precio) <= 0) return res.status(400).json({ error: 'El precio debe ser un número mayor a cero.' });

  try {
    const result = await dbRun(
      `INSERT INTO productos (nombre, costo, precio, stock, codigo_barras, es_combo, activo) VALUES (?, ?, ?, ?, ?, 0, 1)`,
      [nombre.trim(), Number(costo) || 0, Number(precio), Math.floor(Number(stock)) || 0, codigo_barras || '']
    );
    res.json({ id: result.lastID, message: 'Producto creado correctamente.' });
  } catch (err) { res.status(500).json({ error: 'Error al crear producto.' }); }
});

app.put('/api/productos/:id', async (req, res) => {
  const { nombre, costo, precio, stock, codigo_barras } = req.body;
  try {
    await dbRun(
      `UPDATE productos SET nombre = ?, costo = ?, precio = ?, stock = ?, codigo_barras = ? WHERE id = ?`,
      [nombre.trim(), Number(costo) || 0, Number(precio), Math.floor(Number(stock)), codigo_barras || '', req.params.id]
    );
    res.json({ message: 'Producto actualizado.' });
  } catch (err) { res.status(500).json({ error: 'Error al actualizar producto.' }); }
});

app.delete('/api/productos/:id', async (req, res) => {
  try {
    await dbRun(`UPDATE productos SET activo = 0 WHERE id = ?`, [req.params.id]);
    res.json({ message: 'Producto dado de baja.' });
  } catch (err) { res.status(500).json({ error: 'Error al eliminar producto.' }); }
});

app.post('/api/productos/bulk', async (req, res) => {
  const { productos } = req.body;
  if (!Array.isArray(productos) || productos.length === 0) {
    return res.status(400).json({ error: 'No se enviaron datos válidos.' });
  }
  try {
    const tx = await db.transaction('write');
    for (const p of productos) {
      if (p.nombre && Number(p.precio) > 0) {
        await tx.execute({
          sql: `INSERT INTO productos (nombre, costo, precio, stock, codigo_barras, es_combo, activo) VALUES (?, ?, ?, ?, ?, 0, 1)`,
          args: [p.nombre.trim(), Number(p.costo) || 0, Number(p.precio), Math.floor(Number(p.stock)) || 0, p.codigo_barras || '']
        });
      }
    }
    await tx.commit();
    res.json({ message: 'Productos importados con éxito.' });
  } catch (err) { res.status(500).json({ error: 'Error durante la importación masiva.' }); }
});

app.post('/api/combos', async (req, res) => {
  const { nombre, precio, items } = req.body;
  if (!nombre || !precio || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Faltan datos requeridos para el combo.' });
  }
  try {
    const tx = await db.transaction('write');
    let costoCalculado = 0;
    for (const item of items) {
      const resIng = await tx.execute({ sql: `SELECT costo FROM productos WHERE id = ?`, args: [item.ingrediente_id] });
      if (resIng.rows.length > 0) costoCalculado += (Number(resIng.rows[0].costo) * Number(item.cantidad));
    }
    const comboRes = await tx.execute({
      sql: `INSERT INTO productos (nombre, costo, precio, stock, es_combo, activo) VALUES (?, ?, ?, 0, 1, 1)`,
      args: [nombre.trim(), costoCalculado, Number(precio)]
    });
    const comboId = Number(comboRes.lastInsertRowid);
    for (const item of items) {
      await tx.execute({
        sql: `INSERT INTO combo_items (combo_id, ingrediente_id, cantidad) VALUES (?, ?, ?)`,
        args: [comboId, item.ingrediente_id, Number(item.cantidad)]
      });
    }
    await tx.commit();
    res.json({ id: comboId, message: 'Combo creado correctamente.' });
  } catch (err) { res.status(500).json({ error: 'Error al registrar el combo.' }); }
});

// ================= RUTAS DE VENTAS =================
app.post('/api/ventas', async (req, res) => {
  const { producto_id, cantidad, metodo_pago, vendedor } = req.body;
  const cant = Math.floor(Number(cantidad));
  if (!producto_id || cant <= 0) return res.status(400).json({ error: 'Datos de venta inválidos.' });

  try {
    const tx = await db.transaction('write');
    const prodRes = await tx.execute({ sql: `SELECT * FROM productos WHERE id = ? AND activo = 1`, args: [producto_id] });
    if (prodRes.rows.length === 0) { await tx.rollback(); return res.status(404).json({ error: 'Producto no encontrado.' }); }
    const prod = prodRes.rows[0];

    if (prod.es_combo === 0) {
      if (prod.stock < cant) { await tx.rollback(); return res.status(400).json({ error: 'Stock insuficiente.' }); }
      await tx.execute({ sql: `UPDATE productos SET stock = stock - ? WHERE id = ?`, args: [cant, prod.id] });
    } else {
      const compRes = await tx.execute({
        sql: `SELECT ci.cantidad as cant_combo, p.id, p.stock FROM combo_items ci JOIN productos p ON ci.ingrediente_id = p.id WHERE ci.combo_id = ?`,
        args: [prod.id]
      });
      for (const comp of compRes.rows) {
        if (comp.stock < (comp.cant_combo * cant)) { await tx.rollback(); return res.status(400).json({ error: 'Stock insuficiente de uno de los componentes del combo.' }); }
      }
      for (const comp of compRes.rows) {
        await tx.execute({ sql: `UPDATE productos SET stock = stock - ? WHERE id = ?`, args: [comp.cant_combo * cant, comp.id] });
      }
    }

    const totalVenta = prod.precio * cant;
    const ventaRes = await tx.execute({
      sql: `INSERT INTO ventas (metodo_pago, vendedor, total) VALUES (?, ?, ?)`,
      args: [metodo_pago || 'EFECTIVO', (vendedor && vendedor.trim()) ? vendedor.trim() : 'General', totalVenta]
    });
    
    await tx.execute({
      sql: `INSERT INTO ventas_detalle (venta_id, producto_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)`,
      args: [Number(ventaRes.lastInsertRowid), prod.id, cant, prod.precio]
    });

    await tx.commit();
    res.json({ message: 'Venta registrada con éxito.' });
  } catch (err) { res.status(500).json({ error: 'Error al procesar la venta.' }); }
});

app.get('/api/ventas', async (req, res) => {
  try {
    const ventas = await dbAll(`
      SELECT v.id, v.fecha, v.metodo_pago, v.vendedor, v.total,
        GROUP_CONCAT(p.nombre || ' (x' || vd.cantidad || ')', ', ') as items_detalle
      FROM ventas v JOIN ventas_detalle vd ON v.id = vd.venta_id JOIN productos p ON vd.producto_id = p.id
      GROUP BY v.id ORDER BY v.fecha DESC
    `);
    res.json(ventas);
  } catch (err) { res.status(500).json({ error: 'Error al obtener historial.' }); }
});

// RESPALDO DE VENTAS REAL EN ARCHIVO JSON ANTES DE BORRAR
app.delete('/api/ventas/reset', async (req, res) => {
  try {
    const ventas = await dbAll(`SELECT * FROM ventas`);
    const detalles = await dbAll(`SELECT * FROM ventas_detalle`);
    
    const fechaStr = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `backup_ventas_${fechaStr}.json`;
    const backupPath = path.join(backupsDir, backupFilename);
    
    fs.writeFileSync(backupPath, JSON.stringify({ fecha: new Date(), ventas, detalles }, null, 2));

    const tx = await db.transaction('write');
    await tx.execute('DELETE FROM ventas_detalle');
    await tx.execute('DELETE FROM ventas');
    await tx.commit();

    res.json({ message: `Historial vaciado. Copia guardada en /backups/${backupFilename}` });
  } catch (err) { res.status(500).json({ error: 'Error durante el proceso de reseteo.' }); }
});

app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));