const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/db');
const { serializeCharacter } = require('./character');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 3-20 characters.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, passwordHash);

  req.session.userId = result.lastInsertRowid;
  res.json({ success: true, userId: result.lastInsertRowid });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  req.session.userId = user.id;
  res.json({ success: true, userId: user.id });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

router.get('/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.session.userId);
  const character = db.prepare('SELECT * FROM characters WHERE user_id = ?').get(req.session.userId);
  res.json({ user, character: character ? serializeCharacter(character) : null });
});

module.exports = router;
