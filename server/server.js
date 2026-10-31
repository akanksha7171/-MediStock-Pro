require('dotenv').config();
const express = require('express'), cors = require('cors'), bcrypt = require('bcrypt'), jwt = require('jsonwebtoken');
const pool = require('./config/db');
if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing in .env'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL missing in .env'); process.exit(1); }

const app = express();
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://medi-stock-pro.vercel.app',
  ...(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests without an Origin header (e.g. local server tools)
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json());

// ---- helpers ----
const wrap = f => (q, r, n) => f(q, r, n).catch(n);
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
// run(): write SQL with ? placeholders; they are converted to $1,$2,... and rows are returned
const run = (c, sql, p = []) => { let i = 0; return c.query(sql.replace(/\?/g, () => '$' + (++i)), p).then(r => r.rows); };
const one = async (c, sql, p) => (await run(c, sql, p))[0];
const tx = async fn => {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const v = await fn(c); await c.query('COMMIT'); return v; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
};
const r2 = n => Math.round(n * 100) / 100;
const auth = async (req, res, next) => {
  try {
    req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), process.env.JWT_SECRET);
    const u = await one(pool, 'SELECT is_active,role FROM users WHERE id=?', [req.user.id]); // disabled users lose access immediately
    if (!u || !u.is_active) throw new Error('inactive');
    req.user.role = u.role; next();
  } catch { res.status(401).json({ error: 'Please log in again.' }); }
};
const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Only the owner can do this.' });
const audit = (c, uid, action, entity, id, d) => run(c, 'INSERT INTO audit_logs(user_id,action,entity,entity_id,details) VALUES(?,?,?,?,?)', [uid, action, entity, id, JSON.stringify(d || {})]);
const need = (o, f) => { for (const k of f) if (o[k] === undefined || o[k] === null || o[k] === '') throw new HttpError(400, `${k} is required`); };
const STOCK = "COALESCE(SUM(CASE WHEN b.expiry_date>=CURRENT_DATE THEN b.available_qty END),0)";

app.get('/api/health', wrap(async (q, r) => { await pool.query('SELECT 1'); r.json({ ok: true }); }));

app.post('/api/auth/login', wrap(async (q, r) => {
  need(q.body, ['email', 'password']);
  const u = await one(pool, 'SELECT * FROM users WHERE email=? AND is_active=TRUE', [q.body.email]);
  if (!u || !(await bcrypt.compare(q.body.password, u.password_hash))) throw new HttpError(401, 'Wrong email or password.');
  r.json({
    token: jwt.sign({ id: u.id, role: u.role, name: u.name }, process.env.JWT_SECRET, { expiresIn: '8h' }),
    user: { id: u.id, name: u.name, role: u.role },
  });
}));
app.use('/api', auth);

// ---- users / profile ----
app.get('/api/me', wrap(async (q, r) => r.json(await one(pool, 'SELECT id,name,email,role FROM users WHERE id=?', [q.user.id]))));
app.post('/api/auth/change-password', wrap(async (q, r) => {
  need(q.body, ['current', 'next']);
  if (q.body.next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters.');
  const u = await one(pool, 'SELECT password_hash FROM users WHERE id=?', [q.user.id]);
  if (!(await bcrypt.compare(q.body.current, u.password_hash))) throw new HttpError(400, 'Current password is wrong.');
  await run(pool, 'UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(q.body.next, 10), q.user.id]);
  r.json({ ok: true });
}));
app.get('/api/users', adminOnly, wrap(async (q, r) => r.json(await run(pool, 'SELECT id,name,email,role,is_active,created_at FROM users ORDER BY id'))));
app.post('/api/users', adminOnly, wrap(async (q, r) => {
  need(q.body, ['name', 'email', 'password']);
  if (q.body.password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  const x = await one(pool, "INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'staff') RETURNING id", [q.body.name, q.body.email, await bcrypt.hash(q.body.password, 10)]);
  await audit(pool, q.user.id, 'create_staff', 'user', x.id); r.status(201).json({ id: x.id });
}));
app.patch('/api/users/:id/active', adminOnly, wrap(async (q, r) => {
  if (+q.params.id === q.user.id) throw new HttpError(400, 'You cannot disable your own account.');
  await run(pool, 'UPDATE users SET is_active=? WHERE id=?', [!!q.body.active, q.params.id]); r.json({ ok: true });
}));
app.get('/api/settings', wrap(async (q, r) => r.json(await one(pool, 'SELECT * FROM pharmacy_settings WHERE id=1'))));
app.put('/api/settings', adminOnly, wrap(async (q, r) => {
  const b = q.body; need(b, ['name']);
  await run(pool, 'UPDATE pharmacy_settings SET name=?,address=?,phone=?,gstin=? WHERE id=1', [b.name, b.address, b.phone, b.gstin]); r.json({ ok: true });
}));

// ---- medicines ----
app.get('/api/medicines', wrap(async (q, r) => {
  const s = `%${q.query.search || ''}%`;
  r.json(await run(pool, `SELECT m.*,${STOCK} AS stock FROM medicines m LEFT JOIN batches b ON b.medicine_id=m.id WHERE m.is_archived=FALSE AND (m.name ILIKE ? OR m.generic_name ILIKE ? OR m.barcode=?) GROUP BY m.id ORDER BY m.name LIMIT 200`, [s, s, q.query.search || '']));
}));
app.post('/api/medicines', adminOnly, wrap(async (q, r) => {
  need(q.body, ['name']); const b = q.body;
  const x = await one(pool, 'INSERT INTO medicines(name,generic_name,brand,category,dosage_form,strength,manufacturer,barcode,min_stock,tax_percent) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id',
    [b.name, b.generic_name, b.brand, b.category, b.dosage_form, b.strength, b.manufacturer, b.barcode || null, b.min_stock ?? 10, b.tax_percent ?? 12]);
  r.status(201).json({ id: x.id });
}));
app.put('/api/medicines/:id', adminOnly, wrap(async (q, r) => {
  need(q.body, ['name']); const b = q.body;
  await run(pool, 'UPDATE medicines SET name=?,generic_name=?,brand=?,category=?,min_stock=?,tax_percent=? WHERE id=?', [b.name, b.generic_name, b.brand, b.category, b.min_stock ?? 10, b.tax_percent ?? 12, q.params.id]); r.json({ ok: true });
}));
app.delete('/api/medicines/:id', adminOnly, wrap(async (q, r) => { await run(pool, 'UPDATE medicines SET is_archived=TRUE WHERE id=?', [q.params.id]); r.json({ ok: true, archived: true }); }));

// ---- batches / stock ----
app.get('/api/batches', wrap(async (q, r) => {
  const mid = parseInt(q.query.medicine_id, 10);
  r.json(await run(pool, `SELECT b.*,m.name AS medicine,(b.expiry_date-CURRENT_DATE) AS days_left,CASE WHEN b.expiry_date<CURRENT_DATE THEN 'expired' WHEN b.expiry_date-CURRENT_DATE<=30 THEN 'critical' WHEN b.expiry_date-CURRENT_DATE<=90 THEN 'warning' ELSE 'safe' END AS expiry_status FROM batches b JOIN medicines m ON m.id=b.medicine_id ${mid ? 'WHERE b.medicine_id=?' : ''} ORDER BY b.expiry_date`, mid ? [mid] : []));
}));
app.post('/api/stock/adjust', adminOnly, wrap(async (q, r) => {
  need(q.body, ['batch_id', 'change', 'reason']);
  r.json(await tx(async c => {
    const b = await one(c, 'SELECT * FROM batches WHERE id=? FOR UPDATE', [q.body.batch_id]);
    if (!b) throw new HttpError(404, 'Batch not found.');
    const n = b.available_qty + Number(q.body.change);
    if (!Number.isInteger(n) || n < 0 || n > b.received_qty) throw new HttpError(400, 'Stock cannot go below zero or above received quantity.');
    await run(c, 'UPDATE batches SET available_qty=? WHERE id=?', [n, b.id]);
    await run(c, "INSERT INTO stock_movements(batch_id,medicine_id,type,quantity_change,reason,user_id) VALUES(?,?,'adjustment',?,?,?)", [b.id, b.medicine_id, q.body.change, q.body.reason, q.user.id]);
    await audit(c, q.user.id, 'stock_adjust', 'batch', b.id, q.body);
    return { available_qty: n };
  }));
}));

// ---- suppliers ----
app.get('/api/suppliers', wrap(async (q, r) => r.json(await run(pool, 'SELECT * FROM suppliers WHERE is_archived=FALSE ORDER BY company_name'))));
app.post('/api/suppliers', adminOnly, wrap(async (q, r) => {
  need(q.body, ['company_name']); const b = q.body;
  const x = await one(pool, 'INSERT INTO suppliers(company_name,contact_person,phone,email,address,gstin) VALUES(?,?,?,?,?,?) RETURNING id', [b.company_name, b.contact_person, b.phone, b.email, b.address, b.gstin]);
  r.status(201).json({ id: x.id });
}));
app.put('/api/suppliers/:id', adminOnly, wrap(async (q, r) => {
  need(q.body, ['company_name']); const b = q.body;
  await run(pool, 'UPDATE suppliers SET company_name=?,contact_person=?,phone=?,email=?,address=?,gstin=? WHERE id=?', [b.company_name, b.contact_person, b.phone, b.email, b.address, b.gstin, q.params.id]); r.json({ ok: true });
}));
app.delete('/api/suppliers/:id', adminOnly, wrap(async (q, r) => { await run(pool, 'UPDATE suppliers SET is_archived=TRUE WHERE id=?', [q.params.id]); r.json({ ok: true }); }));

// ---- purchases (one transaction: purchase + batches + movements) ----
app.post('/api/purchases', adminOnly, wrap(async (q, r) => {
  need(q.body, ['supplier_id']); const items = q.body.items;
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Add at least one medicine.');
  try {
    r.status(201).json(await tx(async c => {
      let total = 0; const ref = 'PUR-' + Date.now();
      const p = await one(c, 'INSERT INTO purchases(supplier_id,reference_no,total_amount,created_by) VALUES(?,?,0,?) RETURNING id', [q.body.supplier_id, ref, q.user.id]);
      for (const i of items) {
        need(i, ['medicine_id', 'batch_no', 'quantity', 'purchase_price', 'selling_price', 'expiry_date']);
        if (!(i.quantity > 0) || !Number.isInteger(+i.quantity) || i.purchase_price < 0 || i.selling_price < 0) throw new HttpError(400, 'Invalid quantity or price.');
        const b = await one(c, 'INSERT INTO batches(medicine_id,supplier_id,purchase_id,batch_no,purchase_price,selling_price,received_qty,available_qty,mfg_date,expiry_date) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id',
          [i.medicine_id, q.body.supplier_id, p.id, i.batch_no, i.purchase_price, i.selling_price, i.quantity, i.quantity, i.mfg_date || null, i.expiry_date]);
        await run(c, 'INSERT INTO purchase_items(purchase_id,medicine_id,batch_id,quantity,purchase_price,selling_price,expiry_date) VALUES(?,?,?,?,?,?,?)', [p.id, i.medicine_id, b.id, i.quantity, i.purchase_price, i.selling_price, i.expiry_date]);
        await run(c, "INSERT INTO stock_movements(batch_id,medicine_id,type,quantity_change,reference,user_id) VALUES(?,?,'purchase',?,?,?)", [b.id, i.medicine_id, i.quantity, ref, q.user.id]);
        total += i.quantity * i.purchase_price;
      }
      total = r2(total);
      await run(c, 'UPDATE purchases SET total_amount=? WHERE id=?', [total, p.id]);
      await audit(c, q.user.id, 'purchase', 'purchase', p.id, { ref, total });
      return { id: p.id, reference_no: ref, total };
    }));
  } catch (e) { if (e.code === '23505') throw new HttpError(400, 'This batch number already exists for that medicine.'); throw e; }
}));
app.get('/api/purchases', wrap(async (q, r) => r.json(await run(pool, 'SELECT p.*,s.company_name FROM purchases p JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.id DESC LIMIT 100'))));

// ---- sales: atomic, row-locked, expiry + stock re-checked on the server, idempotent ----
app.post('/api/sales', wrap(async (q, r) => {
  need(q.body, ['items', 'payment_method']);
  const { items, payment_method, customer_name, idempotency_key } = q.body;
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Cart is empty.');
  if (!['cash', 'upi', 'card', 'other'].includes(payment_method)) throw new HttpError(400, 'Invalid payment method.');
  if (idempotency_key) { const d = await one(pool, 'SELECT id,invoice_no FROM sales WHERE idempotency_key=?', [idempotency_key]); if (d) return r.json({ id: d.id, invoice_no: d.invoice_no, duplicate: true }); }
  const out = await tx(async c => {
    let sub = 0, disc = 0, tax = 0; const lines = [], used = {};
    const sorted = [...items].sort((a, b) => a.batch_id - b.batch_id); // consistent lock order avoids deadlocks
    for (const i of sorted) {
      const qty = Number(i.quantity);
      if (!Number.isInteger(qty) || qty <= 0) throw new HttpError(400, 'Quantity must be a whole number above zero.');
      const b = await one(c, 'SELECT b.*,m.tax_percent,m.name,(b.expiry_date<CURRENT_DATE) AS is_expired FROM batches b JOIN medicines m ON m.id=b.medicine_id WHERE b.id=? FOR UPDATE OF b', [i.batch_id]);
      if (!b) throw new HttpError(404, 'Batch not found.');
      if (b.is_expired) throw new HttpError(400, `${b.name} (batch ${b.batch_no}) is expired and cannot be sold.`);
      used[b.id] = (used[b.id] || 0) + qty;
      if (b.available_qty < used[b.id]) throw new HttpError(400, `Only ${b.available_qty} units of ${b.name} (batch ${b.batch_no}) are available.`);
      const gross = r2(b.selling_price * qty); const d = Number(i.discount || 0);
      if (d > 0 && q.user.role !== 'admin') throw new HttpError(403, 'Only the owner can give discounts.');
      if (d < 0 || d > gross) throw new HttpError(400, 'Invalid discount.');
      const t = r2((gross - d) * b.tax_percent / 100);
      sub += gross; disc += d; tax += t; lines.push({ b, qty, d, t, total: r2(gross - d + t) });
    }
    const total = r2(sub - disc + tax);
    const inv = 'INV-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
    const s = await one(c, 'INSERT INTO sales(invoice_no,idempotency_key,customer_name,subtotal,discount,tax,total,payment_method,created_by) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id', [inv, idempotency_key || null, customer_name || null, r2(sub), r2(disc), r2(tax), total, payment_method, q.user.id]);
    for (const l of lines) {
      await run(c, 'INSERT INTO sale_items(sale_id,medicine_id,batch_id,quantity,unit_price,unit_cost,discount,tax_percent,tax_amount,line_total) VALUES(?,?,?,?,?,?,?,?,?,?)', [s.id, l.b.medicine_id, l.b.id, l.qty, l.b.selling_price, l.b.purchase_price, l.d, l.b.tax_percent, l.t, l.total]);
      await run(c, 'UPDATE batches SET available_qty=available_qty-? WHERE id=?', [l.qty, l.b.id]);
      await run(c, "INSERT INTO stock_movements(batch_id,medicine_id,type,quantity_change,reference,user_id) VALUES(?,?,'sale',?,?,?)", [l.b.id, l.b.medicine_id, -l.qty, inv, q.user.id]);
    }
    return { id: s.id, invoice_no: inv, total };
  });
  r.status(201).json(out);
}));
app.get('/api/sales', wrap(async (q, r) => r.json(await run(pool, 'SELECT * FROM sales ORDER BY id DESC LIMIT 100'))));
app.get('/api/sales-search', wrap(async (q, r) => {
  const w = ['1=1'], a = [], Q = q.query;
  if (Q.q) { w.push('(invoice_no ILIKE ? OR customer_name ILIKE ?)'); a.push(`%${Q.q}%`, `%${Q.q}%`); }
  if (Q.payment) { w.push('payment_method=?'); a.push(Q.payment); }
  if (Q.from) { w.push('created_at::date>=?::date'); a.push(Q.from); }
  if (Q.to) { w.push('created_at::date<=?::date'); a.push(Q.to); }
  r.json(await run(pool, `SELECT * FROM sales WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT 200`, a));
}));
app.get('/api/sales/:id', wrap(async (q, r) => {
  const s = await one(pool, 'SELECT * FROM sales WHERE id=?', [q.params.id]); if (!s) throw new HttpError(404, 'Sale not found.');
  const items = await run(pool, 'SELECT si.*,m.name,b.batch_no FROM sale_items si JOIN medicines m ON m.id=si.medicine_id JOIN batches b ON b.id=si.batch_id WHERE sale_id=?', [s.id]);
  r.json({ ...s, items });
}));
// Full return: restores every batch, writes movement + return rows, one transaction
app.post('/api/sales/:id/return', adminOnly, wrap(async (q, r) => {
  r.json(await tx(async c => {
    const s = await one(c, 'SELECT * FROM sales WHERE id=? FOR UPDATE', [q.params.id]);
    if (!s) throw new HttpError(404, 'Sale not found.');
    if (s.status !== 'completed') throw new HttpError(400, 'This sale was already returned or cancelled.');
    const items = await run(c, 'SELECT * FROM sale_items WHERE sale_id=? ORDER BY batch_id', [s.id]);
    const reason = q.body.reason || 'Customer return';
    const rt = await one(c, 'INSERT INTO returns(sale_id,reason,refund_amount,created_by) VALUES(?,?,?,?) RETURNING id', [s.id, reason, s.total, q.user.id]);
    for (const i of items) {
      await run(c, 'UPDATE batches SET available_qty=available_qty+? WHERE id=?', [i.quantity, i.batch_id]);
      await run(c, 'INSERT INTO return_items(return_id,sale_item_id,quantity) VALUES(?,?,?)', [rt.id, i.id, i.quantity]);
      await run(c, "INSERT INTO stock_movements(batch_id,medicine_id,type,quantity_change,reason,reference,user_id) VALUES(?,?,'return',?,?,?,?)", [i.batch_id, i.medicine_id, i.quantity, reason, s.invoice_no, q.user.id]);
    }
    await run(c, "UPDATE sales SET status='returned' WHERE id=?", [s.id]);
    await audit(c, q.user.id, 'sale_return', 'sale', s.id, { refund: s.total });
    return { ok: true, refund: s.total };
  }));
}));

// ---- dashboard ----
const LOW = `SELECT * FROM (SELECT m.id,m.name,m.min_stock,${STOCK} AS stock FROM medicines m LEFT JOIN batches b ON b.medicine_id=m.id WHERE m.is_archived=FALSE GROUP BY m.id) x WHERE stock<=min_stock`;
app.get('/api/dashboard', wrap(async (q, r) => {
  const a = await one(pool, `SELECT
   (SELECT COUNT(*) FROM medicines WHERE is_archived=FALSE) AS medicines,
   (SELECT COALESCE(SUM(available_qty),0) FROM batches WHERE expiry_date>=CURRENT_DATE) AS units,
   (SELECT COALESCE(SUM(available_qty*purchase_price),0) FROM batches WHERE expiry_date>=CURRENT_DATE) AS inventory_value,
   (SELECT COALESCE(SUM(total),0) FROM sales WHERE status='completed' AND created_at::date=CURRENT_DATE) AS today_sales,
   (SELECT COALESCE(SUM(total),0) FROM sales WHERE status='completed' AND to_char(created_at,'YYYY-MM')=to_char(CURRENT_DATE,'YYYY-MM')) AS month_sales,
   (SELECT COALESCE(SUM(si.line_total-si.tax_amount-si.unit_cost*si.quantity),0) FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status='completed' AND to_char(s.created_at,'YYYY-MM')=to_char(CURRENT_DATE,'YYYY-MM')) AS gross_profit_month,
   (SELECT COUNT(*) FROM batches WHERE available_qty>0 AND expiry_date<CURRENT_DATE) AS expired_batches,
   (SELECT COUNT(*) FROM batches WHERE available_qty>0 AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE+30) AS expiring_soon`);
  const low = await run(pool, LOW + ' ORDER BY stock');
  r.json({ ...a, low_stock_count: low.length, low_stock: low });
}));
app.get('/api/dashboard/trend', wrap(async (q, r) => r.json(await run(pool,
  `SELECT to_char(d.day,'DD Mon') AS label,COALESCE(SUM(s.total),0) AS total FROM generate_series(CURRENT_DATE-6,CURRENT_DATE,interval '1 day') AS d(day) LEFT JOIN sales s ON s.created_at::date=d.day::date AND s.status='completed' GROUP BY d.day ORDER BY d.day`))));

// ---- notifications (built from live data, de-duplicated) ----
app.get('/api/notifications', wrap(async (q, r) => {
  await run(pool, `INSERT INTO notifications(category,message,dedupe_key) SELECT 'expired',CONCAT(m.name,' batch ',b.batch_no,' has expired'),CONCAT('exp-',b.id) FROM batches b JOIN medicines m ON m.id=b.medicine_id WHERE b.available_qty>0 AND b.expiry_date<CURRENT_DATE ON CONFLICT (dedupe_key) DO NOTHING`);
  await run(pool, `INSERT INTO notifications(category,message,dedupe_key) SELECT 'expiring',CONCAT(m.name,' batch ',b.batch_no,' expires on ',b.expiry_date),CONCAT('soon-',b.id) FROM batches b JOIN medicines m ON m.id=b.medicine_id WHERE b.available_qty>0 AND b.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE+30 ON CONFLICT (dedupe_key) DO NOTHING`);
  await run(pool, `INSERT INTO notifications(category,message,dedupe_key) SELECT 'low_stock',CONCAT(x.name,' is low (',x.stock,' left)'),CONCAT('low-',x.id,'-',x.stock) FROM (${LOW}) x ON CONFLICT (dedupe_key) DO NOTHING`);
  r.json(await run(pool, 'SELECT * FROM notifications ORDER BY is_read,id DESC LIMIT 100'));
}));
app.post('/api/notifications/read-all', wrap(async (q, r) => { await run(pool, 'UPDATE notifications SET is_read=TRUE'); r.json({ ok: true }); }));
app.post('/api/notifications/:id/read', wrap(async (q, r) => { await run(pool, 'UPDATE notifications SET is_read=TRUE WHERE id=?', [q.params.id]); r.json({ ok: true }); }));

// ---- analytics + exports ----
app.get('/api/analytics', wrap(async (q, r) => {
  const p = [q.query.from || '1970-01-01', q.query.to || '2999-12-31'];
  const D = 'BETWEEN ?::date AND ?::date';
  const s = await one(pool, `SELECT COALESCE(SUM(subtotal),0) AS gross,COALESCE(SUM(discount),0) AS discounts,COALESCE(SUM(tax),0) AS tax,COALESCE(SUM(total),0) AS revenue,COUNT(*) AS invoices FROM sales WHERE status='completed' AND created_at::date ${D}`, p);
  const g = await one(pool, `SELECT COALESCE(SUM(si.line_total-si.tax_amount-si.unit_cost*si.quantity),0) AS gross_profit FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status='completed' AND s.created_at::date ${D}`, p);
  const pu = await one(pool, `SELECT COALESCE(SUM(total_amount),0) AS spent FROM purchases WHERE status='received' AND created_at::date ${D}`, p);
  const top = await run(pool, `SELECT m.name,SUM(si.quantity) AS units,SUM(si.line_total) AS revenue FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN medicines m ON m.id=si.medicine_id WHERE s.status='completed' AND s.created_at::date ${D} GROUP BY m.id ORDER BY units DESC LIMIT 5`, p);
  const categories = await run(pool, `SELECT COALESCE(m.category,'Other') AS category,SUM(si.line_total) AS revenue FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN medicines m ON m.id=si.medicine_id WHERE s.status='completed' AND s.created_at::date ${D} GROUP BY COALESCE(m.category,'Other') ORDER BY revenue DESC`, p);
  const x = await one(pool, 'SELECT COALESCE(SUM(available_qty*purchase_price),0) AS expiry_loss FROM batches WHERE expiry_date<CURRENT_DATE');
  r.json({ ...s, ...g, purchase_spend: pu.spent, top, categories, expiry_loss: x.expiry_loss });
}));
const csv = (res, name, rows) => {
  const h = rows.length ? Object.keys(rows[0]) : []; const e = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename=${name}.csv` }).send([h.join(','), ...rows.map(x => h.map(k => e(x[k])).join(','))].join('\n'));
};
app.get('/api/export/:what', adminOnly, wrap(async (q, r) => {
  const m = {
    sales: 'SELECT invoice_no,created_at,customer_name,subtotal,discount,tax,total,payment_method,status FROM sales ORDER BY id DESC',
    inventory: 'SELECT m.name AS medicine,b.batch_no,b.available_qty,b.purchase_price,b.selling_price,b.expiry_date FROM batches b JOIN medicines m ON m.id=b.medicine_id ORDER BY b.expiry_date',
    purchases: 'SELECT p.reference_no,s.company_name AS supplier,p.total_amount,p.status,p.created_at FROM purchases p JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.id DESC',
  };
  if (!m[q.params.what]) throw new HttpError(404, 'Unknown report.');
  csv(r, q.params.what, await run(pool, m[q.params.what]));
}));

// ---- errors ----
app.use((e, q, r, n) => {
  if (e.status) return r.status(e.status).json({ error: e.message });
  if (e.code === '23505') return r.status(400).json({ error: 'This record already exists.' });
  if (e.code === '23514') return r.status(400).json({ error: 'That quantity or value is not allowed.' });
  if (e.code === '22P02' || e.code === '22007') return r.status(400).json({ error: 'Some of the information entered is not valid.' });
  if (e.code === '23503') return r.status(400).json({ error: 'That item is linked to other records and cannot be changed this way.' });
  console.error(e); r.status(500).json({ error: 'Something went wrong. Please try again.' });
});
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log('MediStock API running on port ' + PORT));
