const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is required. Set it before starting the server.');
  process.exit(1);
}
const TELEGRAM_ADMIN = (process.env.TELEGRAM_ADMIN || 's88xy').replace(/^@/, '');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'store.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 cat TEXT NOT NULL,
 price INTEGER NOT NULL,
 avail TEXT NOT NULL CHECK(avail IN ('stock','preorder')),
 stock INTEGER NOT NULL DEFAULT 0,
 image TEXT NOT NULL DEFAULT '',
 desc TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 contact TEXT NOT NULL,
 comment TEXT NOT NULL DEFAULT '',
 total INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'Новый',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 product_id INTEGER NOT NULL,
 name TEXT NOT NULL,
 price INTEGER NOT NULL,
 qty INTEGER NOT NULL,
 avail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL
);
`);

const count = db.prepare('SELECT COUNT(*) c FROM products').get().c;
if (!count) {
 const ins = db.prepare('INSERT INTO products(name,cat,price,avail,stock,image,desc) VALUES(?,?,?,?,?,?,?)');
 const seed = [
  ['Oversize Hoodie','fashion',6990,'stock',7,'','Свободный силуэт'],
  ['Basic T-Shirt Black','fashion',2990,'stock',14,'','Базовая футболка'],
  ['Urban Cargo Pants','fashion',5990,'preorder',0,'','Карго под заказ'],
  ['Minimal Cap','fashion',1990,'stock',9,'','Минималистичная кепка'],
  ['Wireless Headphones','electronics',8990,'stock',4,'','Беспроводные наушники'],
  ['Portable Speaker','electronics',6490,'preorder',0,'','Портативная колонка'],
  ['Smart Watch','electronics',11990,'stock',3,'','Умные часы'],
  ['USB-C Hub','electronics',3490,'stock',10,'','Мультитул USB-C']
 ];
 const tx=db.transaction(()=>seed.forEach(x=>ins.run(...x)));tx();
}
const set = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
set.run('telegram', TELEGRAM_ADMIN);

const sessions = new Map();
const loginAttempts = new Map();
function adminOnly(req,res,next){
 const sid=req.cookies?.dc_admin;
 if (!sid || !sessions.has(sid)) return res.status(401).json({error:'Требуется вход администратора'});
 next();
}
function cookieParser(req,res,next){
 const raw=req.headers.cookie||''; req.cookies={};
 for(const part of raw.split(';')){const [k,...v]=part.trim().split('=');if(k)req.cookies[k]=decodeURIComponent(v.join('='));}
 next();
}
function cleanProduct(body){
 const name=String(body.name||'').trim();
 const cat=body.cat==='electronics'?'electronics':'fashion';
 const price=Math.round(Number(body.price));
 const avail=body.avail==='preorder'?'preorder':'stock';
 const stock=Math.max(0,Math.floor(Number(body.stock||0)));
 const image=String(body.image||'').trim().slice(0,2000);
 const desc=String(body.desc||'').trim().slice(0,2000);
 if(!name || !Number.isFinite(price) || price<=0) throw new Error('Название и корректная цена обязательны');
 return {name,cat,price,avail,stock,image,desc};
}
function telegramText(order,items){
 const lines=['Новый заказ — Drip & Coil','',`Заказ: #${order.id}`,`Клиент: ${order.name}`,`Контакт: ${order.contact}`,'','Товары:',...items.map(p=>`• ${p.name} × ${p.qty} — ${(p.price*p.qty).toLocaleString('ru-RU')} ₽ (${p.avail==='stock'?'в наличии':'под заказ'})`),``,`Итого: ${order.total.toLocaleString('ru-RU')} ₽`];
 if(order.comment) lines.push(`Комментарий: ${order.comment}`);
 return lines.join('\n');
}

const app=express();
app.use(express.json({limit:'1mb'}));
app.use(cookieParser);
app.use(express.static(path.join(__dirname,'public')));

app.get('/api/products',(req,res)=>res.json(db.prepare('SELECT id,name,cat,price,avail,stock,image,desc FROM products ORDER BY id DESC').all()));
app.post('/api/orders',(req,res)=>{
 try{
  const name=String(req.body.name||'').trim().slice(0,100),contact=String(req.body.contact||'').trim().slice(0,150),comment=String(req.body.comment||'').trim().slice(0,1000),raw=Array.isArray(req.body.items)?req.body.items:[];
  if(!name||!contact||!raw.length) return res.status(400).json({error:'Укажи имя, контакт и хотя бы один товар'});
  const ids=raw.map(x=>Number(x.id)).filter(Number.isInteger); const unique=[...new Set(ids)];
  const rows=unique.length?db.prepare(`SELECT id,name,price,avail,stock FROM products WHERE id IN (${unique.map(()=>'?').join(',')})`).all(...unique):[];
  const map=new Map(rows.map(x=>[x.id,x])); const items=[];
  for(const x of raw){const p=map.get(Number(x.id));const qty=Math.max(1,Math.min(99,Math.floor(Number(x.qty||1))));if(!p)continue;if(p.avail==='stock'&&p.stock<qty) return res.status(400).json({error:`Недостаточно товара: ${p.name}`});items.push({...p,qty});}
  if(!items.length) return res.status(400).json({error:'Товары не найдены'});
  const total=items.reduce((s,p)=>s+p.price*p.qty,0);
  const tx=db.transaction(()=>{
   const o=db.prepare('INSERT INTO orders(name,contact,comment,total,status) VALUES(?,?,?,?,?)').run(name,contact,comment,total,'Новый');
   const ins=db.prepare('INSERT INTO order_items(order_id,product_id,name,price,qty,avail) VALUES(?,?,?,?,?,?)');
   for(const p of items) ins.run(o.lastInsertRowid,p.id,p.name,p.price,p.qty,p.avail);
   return Number(o.lastInsertRowid);
  });
  const id=tx(); const order={id,name,contact,comment,total};
  res.json({id,telegramText:telegramText(order,items)});
 }catch(e){res.status(500).json({error:e.message||'Ошибка создания заказа'})}
});

app.post('/api/admin/login',(req,res)=>{
 const ip=req.ip||'unknown', now=Date.now(), a=loginAttempts.get(ip)||{n:0,t:now};
 if(now-a.t>10*60*1000){a.n=0;a.t=now}
 if(a.n>=10) return res.status(429).json({error:'Слишком много попыток. Попробуй позже.'});
 const ok=bcrypt.compareSync(String(req.body.password||''),bcrypt.hashSync(ADMIN_PASSWORD,10));
 if(!ok){a.n++;loginAttempts.set(ip,a);return res.status(401).json({error:'Неверный пароль'})}
 const sid=crypto.randomBytes(32).toString('hex');sessions.set(sid,{created:Date.now()});
 res.setHeader('Set-Cookie',`dc_admin=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${process.env.NODE_ENV==='production'?'; Secure':''}`);
 res.json({ok:true});
});
app.get('/api/admin/me',adminOnly,(req,res)=>res.json({ok:true}));
app.post('/api/admin/logout',adminOnly,(req,res)=>{sessions.delete(req.cookies.dc_admin);res.setHeader('Set-Cookie','dc_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');res.json({ok:true})});
app.get('/api/admin/settings',adminOnly,(req,res)=>res.json({telegram:db.prepare('SELECT value FROM settings WHERE key=?').get('telegram')?.value||''}));
app.put('/api/admin/settings',adminOnly,(req,res)=>{let tg=String(req.body.telegram||'').replace(/^@/,'').trim().slice(0,100);if(!tg)return res.status(400).json({error:'Telegram username обязателен'});set.run('telegram',tg);res.json({ok:true})});
app.get('/api/admin/products',adminOnly,(req,res)=>res.json(db.prepare('SELECT id,name,cat,price,avail,stock,image,desc FROM products ORDER BY id DESC').all()));
app.post('/api/admin/products',adminOnly,(req,res)=>{try{const p=cleanProduct(req.body);const r=db.prepare('INSERT INTO products(name,cat,price,avail,stock,image,desc) VALUES(?,?,?,?,?,?,?)').run(p.name,p.cat,p.price,p.avail,p.stock,p.image,p.desc);res.json({id:Number(r.lastInsertRowid),...p})}catch(e){res.status(400).json({error:e.message})}});
app.put('/api/admin/products/:id',adminOnly,(req,res)=>{try{const p=cleanProduct(req.body),id=Number(req.params.id);const r=db.prepare('UPDATE products SET name=?,cat=?,price=?,avail=?,stock=?,image=?,desc=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(p.name,p.cat,p.price,p.avail,p.stock,p.image,p.desc,id);if(!r.changes)return res.status(404).json({error:'Товар не найден'});res.json({id,...p})}catch(e){res.status(400).json({error:e.message})}});
app.delete('/api/admin/products/:id',adminOnly,(req,res)=>{const r=db.prepare('DELETE FROM products WHERE id=?').run(Number(req.params.id));res.json({ok:!!r.changes})});
app.get('/api/admin/orders',adminOnly,(req,res)=>res.json(db.prepare('SELECT id,name,contact,comment,total,status,created_at FROM orders ORDER BY id DESC').all()));
app.get('/api/admin/orders/:id',adminOnly,(req,res)=>{const o=db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id));if(!o)return res.status(404).json({error:'Заказ не найден'});o.items=db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id);res.json(o)});
app.put('/api/admin/orders/:id',adminOnly,(req,res)=>{const allowed=['Новый','Принят','Выдан','Отменён'];const status=String(req.body.status||'');if(!allowed.includes(status))return res.status(400).json({error:'Недопустимый статус'});const r=db.prepare('UPDATE orders SET status=? WHERE id=?').run(status,Number(req.params.id));res.json({ok:!!r.changes})});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`Drip & Coil running on http://localhost:${PORT}`));
