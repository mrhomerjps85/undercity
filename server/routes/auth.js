const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/db');
const { serializeCharacter } = require('./character');
const { requireAuth } = require('../middleware');

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
  req.session.save((err) => {
    if (err) {
      console.error('[auth] Failed to save session after register:', err);
      return res.status(500).json({ error: 'Could not create your session. Please try again.' });
    }
    res.json({ success: true, userId: result.lastInsertRowid });
  });
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
  if (user.banned) {
    return res.status(403).json({ error: 'This account has been banned.' });
  }

  req.session.userId = user.id;
  req.session.save((err) => {
    if (err) {
      console.error('[auth] Failed to save session after login:', err);
      return res.status(500).json({ error: 'Could not create your session. Please try again.' });
    }
    res.json({ success: true, userId: user.id });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// news_posts.created_at uses sqlite's datetime('now') format ("YYYY-MM-DD HH:MM:SS"),
// while last_news_read_at is set via toISOString() ("YYYY-MM-DDTHH:MM:SS.sssZ") - comparing
// these as raw strings is unreliable (the space/T difference sorts unpredictably), so parse
// both into real timestamps first.
function parseTimestamp(str) {
  if (!str) return 0;
  if (str.includes('T')) return new Date(str).getTime();
  return new Date(str.replace(' ', 'T') + 'Z').getTime();
}

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, username, is_admin, last_news_read_at FROM users WHERE id = ?').get(req.session.userId);
  const character = db.prepare('SELECT * FROM characters WHERE user_id = ?').get(req.session.userId);

  const latestPost = db.prepare('SELECT created_at FROM news_posts ORDER BY created_at DESC LIMIT 1').get();
  const hasUnreadNews = !!latestPost && parseTimestamp(latestPost.created_at) > parseTimestamp(user.last_news_read_at);

  res.json({ user, character: character ? serializeCharacter(character) : null, hasUnreadNews });
});

module.exports = router;
