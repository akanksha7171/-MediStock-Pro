require('dotenv').config();const bcrypt=require('bcrypt'),pool=require('./config/db');
(async()=>{const {ADMIN_EMAIL,ADMIN_PASSWORD}=process.env;if(!ADMIN_EMAIL||!ADMIN_PASSWORD)throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD in .env');
 await pool.query('INSERT IGNORE INTO users(name,email,password_hash,role) VALUES(?,?,?,\'admin\')',['Pharmacy Owner',ADMIN_EMAIL,await bcrypt.hash(ADMIN_PASSWORD,10)]);
 const [[{n}]]=await pool.query('SELECT COUNT(*) n FROM medicines');if(n>0){console.log('Admin ready. Demo data already present.');return process.exit();}
 await pool.query("INSERT INTO suppliers(company_name,contact_person,phone,gstin) VALUES('Sunrise Pharma Distributors','Rakesh Kumar','9000000001','10AAAAA0000A1Z5'),('HealthLine Wholesale','Anita Singh','9000000002','10BBBBB0000B1Z5')");
 const meds=[['Paracetamol 500mg','Paracetamol','Calpol','Pain Relief','Tablet','500mg','8901000000011',20],['Amoxicillin 250mg','Amoxicillin','Mox','Antibiotic','Capsule','250mg','8901000000028',15],['Cetirizine 10mg','Cetirizine','Cetzine','Allergy','Tablet','10mg','8901000000035',10],['ORS Sachet','ORS','Electral','Hydration','Powder','21g','8901000000042',10]];
 for(const m of meds)await pool.query('INSERT INTO medicines(name,generic_name,brand,category,dosage_form,strength,barcode,min_stock) VALUES(?,?,?,?,?,?,?,?)',m);
 const [[u]]=await pool.query('SELECT id FROM users WHERE role=\'admin\' LIMIT 1');
 const [p]=await pool.query("INSERT INTO purchases(supplier_id,reference_no,total_amount,created_by) VALUES(1,'PUR-DEMO-1',0,?)",[u.id]);
 const b=[[1,'PCM-A1',1.2,2,200,'DATE_ADD(CURDATE(),INTERVAL 400 DAY)'],[1,'PCM-OLD',1.1,2,50,'DATE_SUB(CURDATE(),INTERVAL 20 DAY)'],[2,'AMX-B1',4,7,8,'DATE_ADD(CURDATE(),INTERVAL 20 DAY)'],[3,'CTZ-C1',0.8,1.5,100,'DATE_ADD(CURDATE(),INTERVAL 200 DAY)'],[4,'ORS-D1',9,15,6,'DATE_ADD(CURDATE(),INTERVAL 120 DAY)']];
 for(const x of b){const [r]=await pool.query(`INSERT INTO batches(medicine_id,supplier_id,purchase_id,batch_no,purchase_price,selling_price,received_qty,available_qty,expiry_date) VALUES(?,1,?,?,?,?,?,?,${x[5]})`,[x[0],p.insertId,x[1],x[2],x[3],x[4],x[4]]);
  await pool.query("INSERT INTO stock_movements(batch_id,medicine_id,type,quantity_change,reference,user_id) VALUES(?,?,'purchase',?,'PUR-DEMO-1',?)",[r.insertId,x[0],x[4],u.id]);}
 console.log('Seeded admin + demo data.');process.exit();})().catch(e=>{console.error(e.message);process.exit(1);});
