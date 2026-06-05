const express = require('express');
const bcrypt = require('bcrypt');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

if (!fs.existsSync('public')) fs.mkdirSync('public');
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const adapter = new FileSync('db.json');
const db = low(adapter);
db.defaults({ users: [], messages: [] }).write();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const K = 32;
function eloExp(a, b) { return 1 / (1 + Math.pow(10, (b - a) / 400)); }
function eloUpdate(rW, rL) {
  return [
    Math.round(rW + K * (1 - eloExp(rW, rL))),
    Math.round(rL + K * (0 - eloExp(rL, rW)))
  ];
}

app.post('/api/register', upload.single('photo'), async (req, res) => {
  try {
    const { name, pass, gender } = req.body;
    if (!name || !pass || !gender) return res.json({ ok: false, error: 'Заполни все поля' });
    if (pass.length < 4) return res.json({ ok: false, error: 'Пароль минимум 4 символа' });
    if (db.get('users').find({ name }).value()) return res.json({ ok: false, error: 'Ник уже занят' });
    const hash = await bcrypt.hash(pass, 10);
    const photo = req.file ? '/uploads/' + req.file.filename : null;
    const user = { id: Date.now(), name, pass: hash, gender, photo, elo: 1000, wins: 0, losses: 0, joined: Date.now() };
    db.get('users').push(user).write();
    const { pass: _, ...safeUser } = user;
    res.json({ ok: true, user: safeUser });
  } catch (e) {
    res.json({ ok: false, error: 'Ошибка сервера' });
  }
});

app.post('/api/login', async (req, res) => {
  const { name, pass } = req.body;
  const user = db.get('users').find({ name }).value();
  if (!user) return res.json({ ok: false, error: 'Неверное имя или пароль' });
  const ok = await bcrypt.compare(pass, user.pass);
  if (!ok) return res.json({ ok: false, error: 'Неверное имя или пароль' });
  const { pass: _, ...safeUser } = user;
  res.json({ ok: true, user: safeUser });
});

app.get('/api/users', (req, res) => {
  const users = db.get('users').map(u => {
    const { pass, ...safe } = u; return safe;
  }).value();
  res.json(users);
});

app.post('/api/vote', (req, res) => {
  const { winnerName, loserName } = req.body;
  const winner = db.get('users').find({ name: winnerName }).value();
  const loser = db.get('users').find({ name: loserName }).value();
  if (!winner || !loser) return res.json({ ok: false });
  const [newW, newL] = eloUpdate(winner.elo, loser.elo);
  db.get('users').find({ name: winnerName }).assign({ elo: newW, wins: winner.wins + 1 }).write();
  db.get('users').find({ name: loserName }).assign({ elo: newL, losses: loser.losses + 1 }).write();
  io.emit('vote_update');
  res.json({ ok: true });
});

app.post('/api/photo', upload.single('photo'), (req, res) => {
  const { name } = req.body;
  if (!req.file || !name) return res.json({ ok: false });
  const photo = '/uploads/' + req.file.filename;
  db.get('users').find({ name }).assign({ photo }).write();
  res.json({ ok: true, photo });
});

app.delete('/api/user/:name', (req, res) => {
  db.get('users').remove({ name: req.params.name }).write();
  res.json({ ok: true });
});

app.get('/api/messages/:user1/:user2', (req, res) => {
  const { user1, user2 } = req.params;
  const msgs = db.get('messages').filter(m =>
    (m.from === user1 && m.to === user2) || (m.from === user2 && m.to === user1)
  ).value();
  db.get('messages').filter({ to: user1, from: user2 }).each(m => m.read = true).write();
  res.json(msgs);
});

app.post('/api/messages', (req, res) => {
  const { from, to, text } = req.body;
  if (!from || !to || !text) return res.json({ ok: false });
  const msg = { id: Date.now(), from, to, text, ts: Date.now(), read: false };
  db.get('messages').push(msg).write();
  io.to(to).emit('new_message', { from, text, ts: msg.ts });
  res.json({ ok: true });
});

app.get('/api/unread/:user', (req, res) => {
  const count = db.get('messages').filter({ to: req.params.user, read: false }).size().value();
  res.json({ count });
});

io.on('connection', (socket) => {
  socket.on('join', (username) => socket.join(username));
});

server.listen(PORT, () => console.log('RateMe запущен на порту ' + PORT));
