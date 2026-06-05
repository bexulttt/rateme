const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// Папки
if (!fs.existsSync('public')) fs.mkdirSync('public');
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// База данных
const db = new Database('rateme.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    pass TEXT NOT NULL,
    gender TEXT NOT NULL,
    photo TEXT,
    elo INTEGER DEFAULT 1000,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    joined INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL,
    read INTEGER DEFAULT 0
  );
`);

// Multer для фото
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Эло
const K = 32;
function eloExp(a, b) { return 1 / (1 + Math.pow(10, (b - a) / 400)); }
function eloUpdate(rW, rL) {
  return [
    Math.round(rW + K * (1 - eloExp(rW, rL))),
    Math.round(rL + K * (0 - eloExp(rL, rW)))
  ];
}

// === API ===

// Регистрация
app.post('/api/register', upload.single('photo'), async (req, res) => {
  try {
    const { name, pass, gender } = req.body;
    if (!name || !pass || !gender) return res.json({ ok: false, error: 'Заполни все поля' });
    if (pass.length < 4) return res.json({ ok: false, error: 'Пароль минимум 4 символа' });
    const exists = db.prepare('SELECT id FROM users WHERE name=?').get(name);
    if (exists) return res.json({ ok: false, error: 'Ник уже занят' });
    const hash = await bcrypt.hash(pass, 10);
    const photo = req.file ? '/uploads/' + req.file.filename : null;
    db.prepare('INSERT INTO users (name,pass,gender,photo,joined) VALUES (?,?,?,?,?)').run(name, hash, gender, photo, Date.now());
    const user = db.prepare('SELECT id,name,gender,photo,elo,wins,losses FROM users WHERE name=?').get(name);
    res.json({ ok: true, user });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.json({ ok: false, error: 'Ник уже занят' });
    res.json({ ok: false, error: 'Ошибка сервера' });
  }
});

// Вход
app.post('/api/login', async (req, res) => {
  const { name, pass } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE name=?').get(name);
  if (!user) return res.json({ ok: false, error: 'Неверное имя или пароль' });
  const ok = await bcrypt.compare(pass, user.pass);
  if (!ok) return res.json({ ok: false, error: 'Неверное имя или пароль' });
  const { pass: _, ...safeUser } = user;
  res.json({ ok: true, user: safeUser });
});

// Все пользователи
app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT id,name,gender,photo,elo,wins,losses FROM users').all();
  res.json(users);
});

// Голосование
app.post('/api/vote', (req, res) => {
  const { winnerName, loserName } = req.body;
  const winner = db.prepare('SELECT * FROM users WHERE name=?').get(winnerName);
  const loser = db.prepare('SELECT * FROM users WHERE name=?').get(loserName);
  if (!winner || !loser) return res.json({ ok: false });
  const [newW, newL] = eloUpdate(winner.elo, loser.elo);
  db.prepare('UPDATE users SET elo=?,wins=wins+1 WHERE name=?').run(newW, winnerName);
  db.prepare('UPDATE users SET elo=?,losses=losses+1 WHERE name=?').run(newL, loserName);
  io.emit('vote_update');
  res.json({ ok: true });
});

// Смена фото
app.post('/api/photo', upload.single('photo'), (req, res) => {
  const { name } = req.body;
  if (!req.file || !name) return res.json({ ok: false });
  const photo = '/uploads/' + req.file.filename;
  db.prepare('UPDATE users SET photo=? WHERE name=?').run(photo, name);
  res.json({ ok: true, photo });
});

// Удалить аккаунт
app.delete('/api/user/:name', (req, res) => {
  db.prepare('DELETE FROM users WHERE name=?').run(req.params.name);
  res.json({ ok: true });
});

// Сообщения — получить
app.get('/api/messages/:user1/:user2', (req, res) => {
  const { user1, user2 } = req.params;
  const msgs = db.prepare(`
    SELECT * FROM messages 
    WHERE (from_user=? AND to_user=?) OR (from_user=? AND to_user=?)
    ORDER BY ts ASC
  `).all(user1, user2, user2, user1);
  db.prepare('UPDATE messages SET read=1 WHERE to_user=? AND from_user=?').run(user1, user2);
  res.json(msgs);
});

// Сообщения — отправить
app.post('/api/messages', (req, res) => {
  const { from, to, text } = req.body;
  if (!from || !to || !text) return res.json({ ok: false });
  const msg = { from_user: from, to_user: to, text, ts: Date.now(), read: 0 };
  db.prepare('INSERT INTO messages (from_user,to_user,text,ts,read) VALUES (?,?,?,?,?)').run(msg.from_user, msg.to_user, msg.text, msg.ts, msg.read);
  io.to(to).emit('new_message', { from, text, ts: msg.ts });
  res.json({ ok: true });
});

// Непрочитанные
app.get('/api/unread/:user', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as c FROM messages WHERE to_user=? AND read=0').get(req.params.user);
  res.json({ count: count.c });
});

// Socket.io
io.on('connection', (socket) => {
  socket.on('join', (username) => socket.join(username));
});

server.listen(PORT, () => console.log('RateMe запущен на порту ' + PORT));
