const express = require('express');
const bcrypt = require('bcrypt');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

if (!fs.existsSync('public')) fs.mkdirSync('public');
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const MONGODB_URI = process.env.MONGODB_URI;
let db;

MongoClient.connect(MONGODB_URI).then(client => {
  db = client.db('rateme');
  console.log('MongoDB подключён');
  server.listen(PORT, () => console.log('RateMe запущен на порту ' + PORT));
}).catch(err => {
  console.error('Ошибка подключения к MongoDB:', err);
  process.exit(1);
});

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
    const existing = await db.collection('users').findOne({ name });
    if (existing) return res.json({ ok: false, error: 'Ник уже занят' });
    const hash = await bcrypt.hash(pass, 10);
    const photo = req.file ? '/uploads/' + req.file.filename : null;
    const user = { id: Date.now(), name, pass: hash, gender, photo, elo: 1000, wins: 0, losses: 0, joined: Date.now() };
    await db.collection('users').insertOne(user);
    const { pass: _, _id, ...safeUser } = user;
    res.json({ ok: true, user: safeUser });
  } catch (e) {
    res.json({ ok: false, error: 'Ошибка сервера' });
  }
});

app.post('/api/login', async (req, res) => {
  const { name, pass } = req.body;
  const user = await db.collection('users').findOne({ name });
  if (!user) return res.json({ ok: false, error: 'Неверное имя или пароль' });
  const ok = await bcrypt.compare(pass, user.pass);
  if (!ok) return res.json({ ok: false, error: 'Неверное имя или пароль' });
  const { pass: _, _id, ...safeUser } = user;
  res.json({ ok: true, user: safeUser });
});

app.get('/api/users', async (req, res) => {
  const users = await db.collection('users').find({}, { projection: { pass: 0, _id: 0 } }).toArray();
  res.json(users);
});

app.post('/api/vote', async (req, res) => {
  const { winnerName, loserName } = req.body;
  const winner = await db.collection('users').findOne({ name: winnerName });
  const loser = await db.collection('users').findOne({ name: loserName });
  if (!winner || !loser) return res.json({ ok: false });
  const [newW, newL] = eloUpdate(winner.elo, loser.elo);
  await db.collection('users').updateOne({ name: winnerName }, { $set: { elo: newW, wins: winner.wins + 1 } });
  await db.collection('users').updateOne({ name: loserName }, { $set: { elo: newL, losses: loser.losses + 1 } });
  io.emit('vote_update');
  res.json({ ok: true });
});

app.post('/api/photo', upload.single('photo'), async (req, res) => {
  const { name } = req.body;
  if (!req.file || !name) return res.json({ ok: false });
  const photo = '/uploads/' + req.file.filename;
  await db.collection('users').updateOne({ name }, { $set: { photo } });
  res.json({ ok: true, photo });
});

app.delete('/api/user/:name', async (req, res) => {
  await db.collection('users').deleteOne({ name: req.params.name });
  res.json({ ok: true });
});

app.get('/api/messages/:user1/:user2', async (req, res) => {
  const { user1, user2 } = req.params;
  const msgs = await db.collection('messages').find({
    $or: [
      { from: user1, to: user2 },
      { from: user2, to: user1 }
    ]
  }).toArray();
  await db.collection('messages').updateMany({ to: user1, from: user2 }, { $set: { read: true } });
  res.json(msgs.map(({ _id, ...m }) => m));
});

app.post('/api/messages', async (req, res) => {
  const { from, to, text } = req.body;
  if (!from || !to || !text) return res.json({ ok: false });
  const msg = { id: Date.now(), from, to, text, ts: Date.now(), read: false };
  await db.collection('messages').insertOne(msg);
  io.to(to).emit('new_message', { from, text, ts: msg.ts });
  res.json({ ok: true });
});

app.get('/api/unread/:user', async (req, res) => {
  const count = await db.collection('messages').countDocuments({ to: req.params.user, read: false });
  res.json({ count });
});

io.on('connection', (socket) => {
  socket.on('join', (username) => socket.join(username));
});
