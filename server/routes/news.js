const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware');

const router = express.Router();

function requireAdmin(req, res, next) {
  const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !user.is_admin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

const VALID_CATEGORIES = ['update', 'event', 'maintenance'];

// Everyone can read the news feed.
router.get('/', requireAuth, (req, res) => {
  const posts = db.prepare('SELECT * FROM news_posts ORDER BY created_at DESC, id DESC LIMIT 100').all();
  res.json({ posts });
});

// Marks the feed as read up to now - called when the player opens the News tab,
// clears the unread badge.
router.post('/mark-read', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET last_news_read_at = ? WHERE id = ?').run(new Date().toISOString(), req.session.userId);
  res.json({ success: true });
});

router.post('/', requireAuth, requireAdmin, (req, res) => {
  const { title, body, category } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required.' });
  }
  if (!body || !body.trim()) {
    return res.status(400).json({ error: 'Body is required.' });
  }
  const finalCategory = VALID_CATEGORIES.includes(category) ? category : 'update';
  const author = db.prepare('SELECT username FROM users WHERE id = ?').get(req.session.userId);

  const result = db.prepare(`
    INSERT INTO news_posts (title, body, category, author_username) VALUES (?, ?, ?, ?)
  `).run(title.trim(), body.trim(), finalCategory, author.username);

  const post = db.prepare('SELECT * FROM news_posts WHERE id = ?').get(result.lastInsertRowid);
  res.json({ post });
});

router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  const post = db.prepare('SELECT id FROM news_posts WHERE id = ?').get(req.params.id);
  if (!post) {
    return res.status(404).json({ error: 'Post not found.' });
  }
  db.prepare('DELETE FROM news_posts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
