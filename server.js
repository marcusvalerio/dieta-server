const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dieta-secret-mude-em-producao';

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'dieta.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    age INTEGER,
    height_cm INTEGER,
    weight_kg REAL,
    gender TEXT DEFAULT 'male',
    activity TEXT DEFAULT 'moderate',
    goal_weight REAL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS weights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    value REAL NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id),
    UNIQUE(user_id, date)
  );

  CREATE TABLE IF NOT EXISTS day_evals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    humor TEXT,
    energia TEXT,
    fome TEXT,
    nota TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id),
    UNIQUE(user_id, date)
  );

  CREATE TABLE IF NOT EXISTS meal_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    week_start TEXT NOT NULL,
    day_name TEXT NOT NULL,
    meal TEXT NOT NULL,
    item_idx INTEGER NOT NULL,
    checked INTEGER DEFAULT 1,
    FOREIGN KEY(user_id) REFERENCES users(id),
    UNIQUE(user_id, week_start, day_name, meal, item_idx)
  );

  CREATE TABLE IF NOT EXISTS shop_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    week_start TEXT NOT NULL,
    item_key TEXT NOT NULL,
    checked INTEGER DEFAULT 1,
    FOREIGN KEY(user_id) REFERENCES users(id),
    UNIQUE(user_id, week_start, item_key)
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    name TEXT NOT NULL,
    cat TEXT,
    value REAL NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS prep_stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    week_start TEXT NOT NULL,
    item_name TEXT NOT NULL,
    qty INTEGER DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id),
    UNIQUE(user_id, week_start, item_name)
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER PRIMARY KEY,
    fin_meta REAL DEFAULT 300,
    theme TEXT DEFAULT 'auto',
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// ── Auth middleware ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Token ausente' });
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// ── TMB / TDEE calc ───────────────────────────────────────────────────────────
function calcTMB(user) {
  const { age, height_cm, weight_kg, gender } = user;
  if (!age || !height_cm || !weight_kg) return null;
  // Mifflin-St Jeor
  const tmb = gender === 'female'
    ? 10 * weight_kg + 6.25 * height_cm - 5 * age - 161
    : 10 * weight_kg + 6.25 * height_cm - 5 * age + 5;
  const factors = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
  const factor = factors[user.activity] || 1.55;
  const tdee = Math.round(tmb * factor);
  const goal = Math.round(tdee - 500); // deficit de 500 kcal = ~0.5kg/semana
  return { tmb: Math.round(tmb), tdee, goal_calories: goal };
}

// ── Routes: Auth ──────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { name, email, password, age, height_cm, weight_kg, gender, activity, goal_weight } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Campos obrigatórios: nome, email, senha' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const stmt = db.prepare(`INSERT INTO users (name,email,password,age,height_cm,weight_kg,gender,activity,goal_weight)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const result = stmt.run(name, email, hash, age||null, height_cm||null, weight_kg||null,
      gender||'male', activity||'moderate', goal_weight||null);
    const userId = result.lastInsertRowid;

    // Default settings
    db.prepare('INSERT OR IGNORE INTO settings (user_id) VALUES (?)').run(userId);

    // Register initial weight
    if (weight_kg) {
      const today = new Date().toISOString().split('T')[0];
      db.prepare('INSERT OR IGNORE INTO weights (user_id,date,value) VALUES (?,?,?)').run(userId, today, weight_kg);
    }

    const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    const calcs = calcTMB(user);
    const token = jwt.sign({ id: userId, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { ...user, password: undefined }, calcs });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email já cadastrado' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Email ou senha incorretos' });
  const calcs = calcTMB(user);
  const token = jwt.sign({ id: user.id, email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { ...user, password: undefined }, calcs });
});

// ── Routes: Profile ───────────────────────────────────────────────────────────
app.get('/api/me', auth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const settings = db.prepare('SELECT * FROM settings WHERE user_id=?').get(req.user.id);
  const calcs = calcTMB(user);
  res.json({ user: { ...user, password: undefined }, calcs, settings });
});

app.patch('/api/me', auth, (req, res) => {
  const fields = ['name','age','height_cm','weight_kg','gender','activity','goal_weight'];
  const updates = {};
  fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  if (Object.keys(updates).length === 0) return res.json({ ok: true });
  const set = Object.keys(updates).map(k => `${k}=?`).join(',');
  db.prepare(`UPDATE users SET ${set} WHERE id=?`).run(...Object.values(updates), req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({ user: { ...user, password: undefined }, calcs: calcTMB(user) });
});

// ── Routes: Weights ───────────────────────────────────────────────────────────
app.get('/api/weights', auth, (req, res) => {
  const rows = db.prepare('SELECT date,value FROM weights WHERE user_id=? ORDER BY date').all(req.user.id);
  res.json(rows);
});

app.post('/api/weights', auth, (req, res) => {
  const { date, value } = req.body;
  db.prepare('INSERT OR REPLACE INTO weights (user_id,date,value) VALUES (?,?,?)').run(req.user.id, date, value);
  res.json({ ok: true });
});

app.delete('/api/weights/:date', auth, (req, res) => {
  db.prepare('DELETE FROM weights WHERE user_id=? AND date=?').run(req.user.id, req.params.date);
  res.json({ ok: true });
});

// ── Routes: Evals ─────────────────────────────────────────────────────────────
app.get('/api/evals', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM day_evals WHERE user_id=? ORDER BY date DESC LIMIT 30').all(req.user.id);
  const map = {};
  rows.forEach(r => { map[r.date] = { humor: r.humor, energia: r.energia, fome: r.fome, nota: r.nota }; });
  res.json(map);
});

app.post('/api/evals', auth, (req, res) => {
  const { date, humor, energia, fome, nota } = req.body;
  db.prepare(`INSERT OR REPLACE INTO day_evals (user_id,date,humor,energia,fome,nota) VALUES (?,?,?,?,?,?)`)
    .run(req.user.id, date, humor||null, energia||null, fome||null, nota||null);
  res.json({ ok: true });
});

// ── Routes: Meal checks ───────────────────────────────────────────────────────
app.get('/api/checks', auth, (req, res) => {
  const { week } = req.query;
  const rows = db.prepare('SELECT * FROM meal_checks WHERE user_id=? AND week_start=?').all(req.user.id, week);
  const map = {};
  rows.forEach(r => { map[`${r.day_name}__${r.meal}__${r.item_idx}`] = true; });
  res.json(map);
});

app.post('/api/checks', auth, (req, res) => {
  const { week_start, day_name, meal, item_idx, checked } = req.body;
  if (checked) {
    db.prepare(`INSERT OR REPLACE INTO meal_checks (user_id,week_start,day_name,meal,item_idx) VALUES (?,?,?,?,?)`)
      .run(req.user.id, week_start, day_name, meal, item_idx);
  } else {
    db.prepare(`DELETE FROM meal_checks WHERE user_id=? AND week_start=? AND day_name=? AND meal=? AND item_idx=?`)
      .run(req.user.id, week_start, day_name, meal, item_idx);
  }
  res.json({ ok: true });
});

// ── Routes: Shop checks ───────────────────────────────────────────────────────
app.get('/api/shop-checks', auth, (req, res) => {
  const { week } = req.query;
  const rows = db.prepare('SELECT item_key FROM shop_checks WHERE user_id=? AND week_start=? AND checked=1').all(req.user.id, week);
  const map = {};
  rows.forEach(r => { map[r.item_key] = true; });
  res.json(map);
});

app.post('/api/shop-checks', auth, (req, res) => {
  const { week_start, item_key, checked } = req.body;
  if (checked) {
    db.prepare('INSERT OR REPLACE INTO shop_checks (user_id,week_start,item_key) VALUES (?,?,?)').run(req.user.id, week_start, item_key);
  } else {
    db.prepare('DELETE FROM shop_checks WHERE user_id=? AND week_start=? AND item_key=?').run(req.user.id, week_start, item_key);
  }
  res.json({ ok: true });
});

// ── Routes: Purchases ─────────────────────────────────────────────────────────
app.get('/api/purchases', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM purchases WHERE user_id=? ORDER BY date DESC').all(req.user.id);
  res.json(rows.map(r => ({ ...r, val: r.value })));
});

app.post('/api/purchases', auth, (req, res) => {
  const { date, name, cat, val } = req.body;
  const result = db.prepare('INSERT INTO purchases (user_id,date,name,cat,value) VALUES (?,?,?,?,?)').run(req.user.id, date, name, cat, val);
  res.json({ id: result.lastInsertRowid.toString(), date, name, cat, val });
});

app.delete('/api/purchases/:id', auth, (req, res) => {
  db.prepare('DELETE FROM purchases WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── Routes: Prep stock ────────────────────────────────────────────────────────
app.get('/api/prep', auth, (req, res) => {
  const { week } = req.query;
  const rows = db.prepare('SELECT item_name,qty FROM prep_stock WHERE user_id=? AND week_start=?').all(req.user.id, week);
  const map = {};
  rows.forEach(r => { map[r.item_name] = r.qty; });
  res.json(map);
});

app.post('/api/prep', auth, (req, res) => {
  const { week_start, item_name, qty } = req.body;
  db.prepare('INSERT OR REPLACE INTO prep_stock (user_id,week_start,item_name,qty) VALUES (?,?,?,?)').run(req.user.id, week_start, item_name, qty);
  res.json({ ok: true });
});

// ── Routes: Settings ─────────────────────────────────────────────────────────
app.patch('/api/settings', auth, (req, res) => {
  const { fin_meta, theme } = req.body;
  db.prepare('INSERT OR REPLACE INTO settings (user_id,fin_meta,theme) VALUES (?,?,?)').run(req.user.id, fin_meta||300, theme||'auto');
  res.json({ ok: true });
});

// ── Fallback ──────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
