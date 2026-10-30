require('dotenv').config();
const express=require('express'),cors=require('cors'),bcrypt=require('bcrypt'),jwt=require('jsonwebtoken');
const pool=require('./config/db');
if(!process.env.JWT_SECRET){console.error('JWT_SECRET missing in .env');process.exit(1);}
const app=express();app.use(cors({origin:/localhost:\d+$/}));app.use(express.json());
const wrap=f=>(q,r,n)=>f(q,r,n).catch(n);
class HttpError extends Error{constructor(s,m){super(m);this.status=s;}}
const auth=(req,res,next)=>{try{req.user=jwt.verify((req.headers.authorization||'').replace('Bearer ',''),process.env.JWT_SECRET);next();}catch{res.status(401).json({error:'Please log in again.'});}};
const adminOnly=(req,res,next)=>req.user.role==='admin'?next():res.status(403).json({error:'Only the owner can do this.'});
const audit=(c,uid,action,entity,id,d)=>c.query('INSERT INTO audit_logs(user_id,action,entity,entity_id,details) VALUES(?,?,?,?,?)',[uid,action,entity,id,JSON.stringify(d||{})]);
const need=(o,f)=>{for(const k of f)if(o[k]===undefined||o[k]===null||o[k]==='')throw new HttpError(400,`${k} is required`);};

app.get('/api/health',wrap(async(q,r)=>{await pool.query('SELECT 1');r.json({ok:true});}));
app.post('/api/auth/login',wrap(async(q,r)=>{need(q.body,['email','password']);
 const [[u]]=await pool.query('SELECT * FROM users WHERE email=? AND is_active=1',[q.body.email]);
 if(!u||!(await bcrypt.compare(q.body.password,u.password_hash)))throw new HttpError(401,'Wrong email or password.');
 r.json({token:jwt.sign({id:u.id,role:u.role,name:u.name},process.env.JWT_SECRET,{expiresIn:'8h'}),user:{id:u.id,name:u.name,role:u.role}});}));
app.use('/api',auth);

app.post('/api/users',adminOnly,wrap(async(q,r)=>{need(q.body,['name','email','password']);
 if(q.body.password.length<8)throw new HttpError(400,'Password must be at least 8 characters.');
 const [x]=await pool.query('INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,\'staff\')',[q.body.name,q.body.email,await bcrypt.hash(q.body.password,10)]);
 await audit(pool,q.user.id,'create_staff','user',x.insertId);r.status(201).json({id:x.insertId});}));

// Medicines
app.get('/api/medicines',wrap(async(q,r)=>{const s=`%${q.query.search||''}%`;
 const [rows]=await pool.query(`SELECT m.*,COALESCE(SUM(CASE WHEN b.expiry_date>=CURDATE() THEN b.available_qty END),0) AS stock FROM medicines m LEFT JOIN batches b ON b.medicine_id=m.id WHERE m.is_archived=0 AND (m.name LIKE ? OR m.generic_name LIKE ? OR m.barcode=?) GROUP BY m.id ORDER BY m.name LIMIT 200`,[s,s,q.query.search||'']);r.json(rows);}));
app.post('/api/medicines',adminOnly,wrap(async(q,r)=>{need(q.body,['name']);const b=q.body;
 const [x]=await pool.query('INSERT INTO medicines(name,generic_name,brand,category,dosage_form,strength,manufacturer,barcode,min_stock,tax_percent) VALUES(?,?,?,?,?,?,?,?,?,?)',[b.name,b.generic_name,b.brand,b.category,b.dosage_form,b.strength,b.manufacturer,b.barcode||null,b.min_stock??10,b.tax_percent??12]);r.status(201).json({id:x.insertId});}));
app.put('/api/medicines/:id',adminOnly,wrap(async(q,r)=>{need(q.body,['name']);const b=q.body;
 await pool.query('UPDATE medicines SET name=?,generic_name=?,brand=?,category=?,min_stock=?,tax_percent=? WHERE id=?',[b.name,b.generic_name,b.brand,b.category,b.min_stock??10,b.tax_percent??12,q.params.id]);r.json({ok:true});}));
app.delete('/api/medicines/:id',adminOnly,wrap(async(q,r)=>{await pool.query('UPDATE medicines SET is_archived=1 WHERE id=?',[q.params.id]);r.json({ok:true,archived:true});}));

// Batches + expiry status
app.get('/api/batches',wrap(async(q,r)=>{const [rows]=await pool.query(`SELECT b.*,m.name AS medicine,DATEDIFF(b.expiry_date,CURDATE()) AS days_left,CASE WHEN b.expiry_date<CURDATE() THEN 'expired' WHEN DATEDIFF(b.expiry_date,CURDATE())<=30 THEN 'critical' WHEN DATEDIFF(b.expiry_date,CURDATE())<=90 THEN 'warning' ELSE 'safe' END AS expiry_status FROM batches b JOIN medicines m ON m.id=b.medicine_id WHERE (?='' OR b.medicine_id=?) ORDER BY b.expiry_date`,[q.query.medicine_id||'',q.query.medicine_id||0]);r.json(rows);}));
app.post('/api/stock/adjust',adminOnly,wrap(async(q,r)=>{need(q.body,['batch_id','change','reason']);const c=await pool.getConnection();
 try{await c.beginTransaction();const [[b]]=await c.query('SELECT * FROM batches WHERE id=? FOR UPDATE',[q.body.batch_id]);
 if(!b)throw new HttpError(404,'Batch not found.');const n=b.available_qty+Number(q.body.change);
 if(n<0||n>b.received_qty)throw new HttpError(400,'Stock cannot go below zero or above received quantity.');
 await c.query('UPDATE batches SET available_qty=? WHERE id=?',[n,b.id]);
 await c.query('INSERT INTO stock_movements(batch_id,medicine_id,type,quantity_change,reason,user_id) VALUES(?,?,\'adjustment\',?,?,?)',[b.id,b.medicine_id,q.body.change,q.body.reason,q.user.id]);
 await audit(c,q.user.id,'stock_adjust','batch',b.id,q.body);await c.commit();r.json({available_qty:n});}
 catch(e){await c.rollback();throw e;}finally{c.release();}}));

// Suppliers
app.get('/api/suppliers',wrap(async(q,r)=>r.json((await pool.query('SELECT * FROM suppliers WHERE is_archived=0 ORDER BY company_name'))[0])));
app.post('/api/suppliers',adminOnly,wrap(async(q,r)=>{need(q.body,['company_name']);const b=q.body;
 const [x]=await pool.query('INSERT INTO suppliers(company_name,contact_person,phone,email,address,gstin) VALUES(?,?,?,?,?,?)',[b.company_name,b.contact_person,b.phone,b.email,b.address,b.gstin]);r.status(201).json({id:x.insertId});}));

// Purchases (transaction; creates batches + movements)
app.post('/api/purchases',adminOnly,wrap(async(q,r)=>{need(q.body,['supplier_id']);const items=q.body.items;
 if(!Array.isArray(items)||!items.length)throw new HttpError(400,'Add at least one medicine.');
 const c=await pool.getConnection();
 try{await c.beginTransaction();let total=0;const ref='PUR-'+Date.now();
 const [p]=await c.query('INSERT INTO purchases(supplier_id,reference_no,total_amount,created_by) VALUES(?,?,0,?)',[q.body.supplier_id,ref,q.user.id]);
 for(const i of items){need(i,['medicine_id','batch_no','quantity','purchase_price','selling_price','expiry_date']);
  if(!(i.quantity>0)||i.purchase_price<0||i.selling_price<0)throw new HttpError(400,'Invalid quantity or price.');
  const [b]=await c.query('INSERT INTO batches(medicine_id,supplier_id,purchase_id,batch_no,purchase_price,selling_price,received_qty,available_qty,mfg_date,expiry_date) VALUES(?,?,?,?,?,?,?,?,?,?)',[i.medicine_id,q.body.supplier_id,p.insertId,i.batch_no,i.purchase_price,i.selling_price,i.quantity,i.quantity,i.mfg_date||null,i.expiry_date]);
  await c.query('INSERT INTO purchase_items(purchase_id,medicine_id,batch_id,quantity,purchase_price,selling_price,expiry_date) VALUES(?,?,?,?,?,?,?)',[p.insertId,i.medicine_id,b.insertId,i.quantity,i.purchase_price,i.selling_price,i.expiry_date]);
  await c.query('INSERT INTO stock_movements(batch_id,medicine_id,type,quantity_change,reference,user_id) VALUES(?,?,\'purchase\',?,?,?)',[b.insertId,i.medicine_id,i.quantity,ref,q.user.id]);
  total+=i.quantity*i.purchase_price;}
 await c.query('UPDATE purchases SET total_amount=? WHERE id=?',[total.toFixed(2),p.insertId]);
 await audit(c,q.user.id,'purchase','purchase',p.insertId,{ref,total});await c.commit();r.status(201).json({id:p.insertId,reference_no:ref,total});}
 catch(e){await c.rollback();if(e.code==='ER_DUP_ENTRY')e=new HttpError(400,'This batch number already exists for that medicine.');throw e;}finally{c.release();}}));
app.get('/api/purchases',wrap(async(q,r)=>r.json((await pool.query('SELECT p.*,s.company_name FROM purchases p JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.id DESC LIMIT 100'))[0])));

// Sales: atomic, row-locked, expiry + stock re-checked on server, idempotent
app.post('/api/sales',wrap(async(q,r)=>{need(q.body,['items','payment_method']);const {items,payment_method,customer_name,idempotency_key}=q.body;
 if(!Array.isArray(items)||!items.length)throw new HttpError(400,'Cart is empty.');
 if(!['cash','upi','card','other'].includes(payment_method))throw new HttpError(400,'Invalid payment method.');
 if(idempotency_key){const [[d]]=await pool.query('SELECT id,invoice_no FROM sales WHERE idempotency_key=?',[idempotency_key]);if(d)return r.json({id:d.id,invoice_no:d.invoice_no,duplicate:true});}
 const c=await pool.getConnection();
 try{await c.beginTransaction();let sub=0,disc=0,tax=0;const lines=[];
 for(const i of items){const qty=Number(i.quantity);if(!Number.isInteger(qty)||qty<=0)throw new HttpError(400,'Quantity must be a whole number above zero.');
  const [[b]]=await c.query('SELECT b.*,m.tax_percent,m.name FROM batches b JOIN medicines m ON m.id=b.medicine_id WHERE b.id=? FOR UPDATE',[i.batch_id]);
  if(!b)throw new HttpError(404,'Batch not found.');
  if(b.expiry_date<new Date().toISOString().slice(0,10))throw new HttpError(400,`${b.name} (batch ${b.batch_no}) is expired and cannot be sold.`);
  if(b.available_qty<qty)throw new HttpError(400,`Only ${b.available_qty} units of ${b.name} (batch ${b.batch_no}) are available.`);
  const gross=b.selling_price*qty;let d=Number(i.discount||0);
  if(d>0&&q.user.role!=='admin')throw new HttpError(403,'Only the owner can give discounts.');
  if(d<0||d>gross)throw new HttpError(400,'Invalid discount.');
  const t=+((gross-d)*b.tax_percent/100).toFixed(2);sub+=gross;disc+=d;tax+=t;lines.push({b,qty,d,t,total:+(gross-d+t).toFixed(2)});}
 const total=+(sub-disc+tax).toFixed(2);const inv='INV-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+Math.random().toString(36).slice(2,7).toUpperCase();
 const [s]=await c.query('INSERT INTO sales(invoice_no,idempotency_key,customer_name,subtotal,discount,tax,total,payment_method,created_by) VALUES(?,?,?,?,?,?,?,?,?)',[inv,idempotency_key||null,customer_name||null,sub.toFixed(2),disc.toFixed(2),tax.toFixed(2),total,payment_method,q.user.id]);
 for(const l of lines){await c.query('INSERT INTO sale_items(sale_id,medicine_id,batch_id,quantity,unit_price,unit_cost,discount,tax_percent,tax_amount,line_total) VALUES(?,?,?,?,?,?,?,?,?,?)',[s.insertId,l.b.medicine_id,l.b.id,l.qty,l.b.selling_price,l.b.purchase_price,l.d,l.b.tax_percent,l.t,l.total]);
  await c.query('UPDATE batches SET available_qty=available_qty-? WHERE id=?',[l.qty,l.b.id]);
  await c.query('INSERT INTO stock_movements(batch_id,medicine_id,type,quantity_change,reference,user_id) VALUES(?,?,\'sale\',?,?,?)',[l.b.id,l.b.medicine_id,-l.qty,inv,q.user.id]);}
 await c.commit();r.status(201).json({id:s.insertId,invoice_no:inv,total});}
 catch(e){await c.rollback();throw e;}finally{c.release();}}));
app.get('/api/sales',wrap(async(q,r)=>r.json((await pool.query('SELECT * FROM sales ORDER BY id DESC LIMIT 100'))[0])));
app.get('/api/sales/:id',wrap(async(q,r)=>{const [[s]]=await pool.query('SELECT * FROM sales WHERE id=?',[q.params.id]);if(!s)throw new HttpError(404,'Sale not found.');
 const [items]=await pool.query('SELECT si.*,m.name,b.batch_no FROM sale_items si JOIN medicines m ON m.id=si.medicine_id JOIN batches b ON b.id=si.batch_id WHERE sale_id=?',[s.id]);r.json({...s,items});}));

// Dashboard (real SQL) + low stock
app.get('/api/dashboard',wrap(async(q,r)=>{const g=async(sql)=>(await pool.query(sql))[0][0];
 const a=await g(`SELECT (SELECT COUNT(*) FROM medicines WHERE is_archived=0) medicines,(SELECT COALESCE(SUM(available_qty),0) FROM batches WHERE expiry_date>=CURDATE()) units,(SELECT COALESCE(SUM(available_qty*purchase_price),0) FROM batches WHERE expiry_date>=CURDATE()) inventory_value,(SELECT COALESCE(SUM(total),0) FROM sales WHERE status='completed' AND DATE(created_at)=CURDATE()) today_sales,(SELECT COALESCE(SUM(total),0) FROM sales WHERE status='completed' AND DATE_FORMAT(created_at,'%Y-%m')=DATE_FORMAT(CURDATE(),'%Y-%m')) month_sales,(SELECT COALESCE(SUM(si.line_total-si.tax_amount-si.unit_cost*si.quantity),0) FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status='completed' AND DATE_FORMAT(s.created_at,'%Y-%m')=DATE_FORMAT(CURDATE(),'%Y-%m')) gross_profit_month,(SELECT COUNT(*) FROM batches WHERE available_qty>0 AND expiry_date<CURDATE()) expired_batches,(SELECT COUNT(*) FROM batches WHERE available_qty>0 AND expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(),INTERVAL 30 DAY)) expiring_soon`);
 const [low]=await pool.query(`SELECT m.id,m.name,m.min_stock,COALESCE(SUM(CASE WHEN b.expiry_date>=CURDATE() THEN b.available_qty END),0) stock FROM medicines m LEFT JOIN batches b ON b.medicine_id=m.id WHERE m.is_archived=0 GROUP BY m.id HAVING stock<=m.min_stock ORDER BY stock`);
 r.json({...a,low_stock_count:low.length,low_stock:low});}));

app.get('/api/dashboard/trend',wrap(async(q,r)=>r.json((await pool.query("SELECT DATE_FORMAT(d.day,'%d %b') label,COALESCE(SUM(s.total),0) total FROM (SELECT CURDATE()-INTERVAL n DAY day FROM (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6) x) d LEFT JOIN sales s ON DATE(s.created_at)=d.day AND s.status='completed' GROUP BY d.day ORDER BY d.day"))[0])));
// Notifications (generated from live data, de-duplicated)
app.get('/api/notifications',wrap(async(q,r)=>{
 await pool.query(`INSERT IGNORE INTO notifications(category,message,dedupe_key) SELECT 'expired',CONCAT(m.name,' batch ',b.batch_no,' has expired'),CONCAT('exp-',b.id) FROM batches b JOIN medicines m ON m.id=b.medicine_id WHERE b.available_qty>0 AND b.expiry_date<CURDATE()`);
 await pool.query(`INSERT IGNORE INTO notifications(category,message,dedupe_key) SELECT 'expiring',CONCAT(m.name,' batch ',b.batch_no,' expires on ',b.expiry_date),CONCAT('soon-',b.id) FROM batches b JOIN medicines m ON m.id=b.medicine_id WHERE b.available_qty>0 AND b.expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(),INTERVAL 30 DAY)`);
 await pool.query(`INSERT IGNORE INTO notifications(category,message,dedupe_key) SELECT 'low_stock',CONCAT(x.name,' is low (',x.stock,' left)'),CONCAT('low-',x.id,'-',x.stock) FROM (SELECT m.id,m.name,m.min_stock,COALESCE(SUM(CASE WHEN b.expiry_date>=CURDATE() THEN b.available_qty END),0) stock FROM medicines m LEFT JOIN batches b ON b.medicine_id=m.id WHERE m.is_archived=0 GROUP BY m.id HAVING stock<=m.min_stock) x`);
 r.json((await pool.query('SELECT * FROM notifications ORDER BY is_read,id DESC LIMIT 100'))[0]);}));
app.post('/api/notifications/read-all',wrap(async(q,r)=>{await pool.query('UPDATE notifications SET is_read=1');r.json({ok:true});}));


// ---- Stage 3 additions ----
app.get('/api/me',wrap(async(q,r)=>r.json((await pool.query('SELECT id,name,email,role FROM users WHERE id=?',[q.user.id]))[0][0])));
app.post('/api/auth/change-password',wrap(async(q,r)=>{need(q.body,['current','next']);if(q.body.next.length<8)throw new HttpError(400,'New password must be at least 8 characters.');
 const [[u]]=await pool.query('SELECT password_hash FROM users WHERE id=?',[q.user.id]);if(!(await bcrypt.compare(q.body.current,u.password_hash)))throw new HttpError(400,'Current password is wrong.');
 await pool.query('UPDATE users SET password_hash=? WHERE id=?',[await bcrypt.hash(q.body.next,10),q.user.id]);r.json({ok:true});}));
app.get('/api/users',adminOnly,wrap(async(q,r)=>r.json((await pool.query('SELECT id,name,email,role,is_active,created_at FROM users ORDER BY id'))[0])));
app.patch('/api/users/:id/active',adminOnly,wrap(async(q,r)=>{if(+q.params.id===q.user.id)throw new HttpError(400,'You cannot disable your own account.');await pool.query('UPDATE users SET is_active=? WHERE id=?',[q.body.active?1:0,q.params.id]);r.json({ok:true});}));
app.get('/api/settings',wrap(async(q,r)=>r.json((await pool.query('SELECT * FROM pharmacy_settings WHERE id=1'))[0][0])));
app.put('/api/settings',adminOnly,wrap(async(q,r)=>{const b=q.body;need(b,['name']);await pool.query('UPDATE pharmacy_settings SET name=?,address=?,phone=?,gstin=? WHERE id=1',[b.name,b.address,b.phone,b.gstin]);r.json({ok:true});}));
app.put('/api/suppliers/:id',adminOnly,wrap(async(q,r)=>{need(q.body,['company_name']);const b=q.body;await pool.query('UPDATE suppliers SET company_name=?,contact_person=?,phone=?,email=?,address=?,gstin=? WHERE id=?',[b.company_name,b.contact_person,b.phone,b.email,b.address,b.gstin,q.params.id]);r.json({ok:true});}));
app.delete('/api/suppliers/:id',adminOnly,wrap(async(q,r)=>{await pool.query('UPDATE suppliers SET is_archived=1 WHERE id=?',[q.params.id]);r.json({ok:true});}));
app.post('/api/notifications/:id/read',wrap(async(q,r)=>{await pool.query('UPDATE notifications SET is_read=1 WHERE id=?',[q.params.id]);r.json({ok:true});}));
app.get('/api/sales-search',wrap(async(q,r)=>{const w=['1=1'],a=[];const Q=q.query;
 if(Q.q){w.push('(invoice_no LIKE ? OR customer_name LIKE ?)');a.push(`%${Q.q}%`,`%${Q.q}%`);}
 if(Q.payment){w.push('payment_method=?');a.push(Q.payment);}if(Q.from){w.push('DATE(created_at)>=?');a.push(Q.from);}if(Q.to){w.push('DATE(created_at)<=?');a.push(Q.to);}
 r.json((await pool.query(`SELECT * FROM sales WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT 200`,a))[0]);}));
// Full return/cancel: restores each batch, records movements + return rows, all in one transaction
app.post('/api/sales/:id/return',adminOnly,wrap(async(q,r)=>{const c=await pool.getConnection();
 try{await c.beginTransaction();const [[s]]=await c.query('SELECT * FROM sales WHERE id=? FOR UPDATE',[q.params.id]);
 if(!s)throw new HttpError(404,'Sale not found.');if(s.status!=='completed')throw new HttpError(400,'This sale was already returned or cancelled.');
 const [items]=await c.query('SELECT * FROM sale_items WHERE sale_id=?',[s.id]);
 const [rt]=await c.query('INSERT INTO returns(sale_id,reason,refund_amount,created_by) VALUES(?,?,?,?)',[s.id,q.body.reason||'Customer return',s.total,q.user.id]);
 for(const i of items){await c.query('SELECT id FROM batches WHERE id=? FOR UPDATE',[i.batch_id]);await c.query('UPDATE batches SET available_qty=available_qty+? WHERE id=?',[i.quantity,i.batch_id]);
  await c.query('INSERT INTO return_items(return_id,sale_item_id,quantity) VALUES(?,?,?)',[rt.insertId,i.id,i.quantity]);
  await c.query("INSERT INTO stock_movements(batch_id,medicine_id,type,quantity_change,reason,reference,user_id) VALUES(?,?,'return',?,?,?,?)",[i.batch_id,i.medicine_id,i.quantity,q.body.reason||'Customer return',s.invoice_no,q.user.id]);}
 await c.query("UPDATE sales SET status='returned' WHERE id=?",[s.id]);await audit(c,q.user.id,'sale_return','sale',s.id,{refund:s.total});await c.commit();r.json({ok:true,refund:s.total});}
 catch(e){await c.rollback();throw e;}finally{c.release();}}));
app.get('/api/analytics',wrap(async(q,r)=>{const f=q.query.from||'1970-01-01',t=q.query.to||'2999-12-31';const p=[f,t];
 const [[s]]=await pool.query(`SELECT COALESCE(SUM(subtotal),0) gross,COALESCE(SUM(discount),0) discounts,COALESCE(SUM(tax),0) tax,COALESCE(SUM(total),0) revenue,COUNT(*) invoices FROM sales WHERE status='completed' AND DATE(created_at) BETWEEN ? AND ?`,p);
 const [[g]]=await pool.query(`SELECT COALESCE(SUM(si.line_total-si.tax_amount-si.unit_cost*si.quantity),0) gross_profit FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status='completed' AND DATE(s.created_at) BETWEEN ? AND ?`,p);
 const [[pu]]=await pool.query(`SELECT COALESCE(SUM(total_amount),0) spent FROM purchases WHERE status='received' AND DATE(created_at) BETWEEN ? AND ?`,p);
 const [top]=await pool.query(`SELECT m.name,SUM(si.quantity) units,SUM(si.line_total) revenue FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN medicines m ON m.id=si.medicine_id WHERE s.status='completed' AND DATE(s.created_at) BETWEEN ? AND ? GROUP BY m.id ORDER BY units DESC LIMIT 5`,p);
 const [cat]=await pool.query(`SELECT COALESCE(m.category,'Other') category,SUM(si.line_total) revenue FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN medicines m ON m.id=si.medicine_id WHERE s.status='completed' AND DATE(s.created_at) BETWEEN ? AND ? GROUP BY category ORDER BY revenue DESC`,p);
 const [[x]]=await pool.query('SELECT COALESCE(SUM(available_qty*purchase_price),0) expiry_loss FROM batches WHERE expiry_date<CURDATE()');
 r.json({...s,...g,purchase_spend:pu.spent,top,categories:cat,expiry_loss:x.expiry_loss});}));
const csv=(res,name,rows)=>{const h=rows.length?Object.keys(rows[0]):[];const e=v=>`"${String(v??'').replace(/"/g,'""')}"`;res.set({'Content-Type':'text/csv','Content-Disposition':`attachment; filename=${name}.csv`}).send([h.join(','),...rows.map(x=>h.map(k=>e(x[k])).join(','))].join('\n'));};
app.get('/api/export/:what',adminOnly,wrap(async(q,r)=>{const m={sales:'SELECT invoice_no,created_at,customer_name,subtotal,discount,tax,total,payment_method,status FROM sales ORDER BY id DESC',inventory:"SELECT m.name medicine,b.batch_no,b.available_qty,b.purchase_price,b.selling_price,b.expiry_date FROM batches b JOIN medicines m ON m.id=b.medicine_id ORDER BY b.expiry_date",purchases:'SELECT p.reference_no,s.company_name supplier,p.total_amount,p.status,p.created_at FROM purchases p JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.id DESC'};
 if(!m[q.params.what])throw new HttpError(404,'Unknown report.');csv(r,q.params.what,(await pool.query(m[q.params.what]))[0]);}));
app.use((e,q,r,n)=>{if(e.status)return r.status(e.status).json({error:e.message});
 if(e.code==='ER_DUP_ENTRY')return r.status(400).json({error:'This record already exists.'});console.error(e);r.status(500).json({error:'Something went wrong. Please try again.'});});
app.listen(process.env.PORT||5000,()=>console.log('MediStock API running on port '+(process.env.PORT||5000)));
