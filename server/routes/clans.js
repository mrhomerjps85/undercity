const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const { serializeCharacter } = require('./character');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const clans = db.prepare(`
    SELECT cl.id, cl.name, COUNT(c.id) as member_count
    FROM clans cl
    LEFT JOIN characters c ON c.clan_id = cl.id
    GROUP BY cl.id
    ORDER BY member_count DESC
  `).all();
  res.json({ clans });
});

router.post('/create', requireAuth, requireCharacter, (req, res) => {
  const { name } = req.body;
  if (!name || name.length < 3 || name.length > 25) {
    return res.status(400).json({ error: 'Clan name must be 3-25 characters.' });
  }
  if (req.character.clan_id) {
    return res.status(400).json({ error: 'You are already in a clan. Leave it first.' });
  }
  const existing = db.prepare('SELECT id FROM clans WHERE name = ?').get(name);
  if (existing) {
    return res.status(409).json({ error: 'That clan name is taken.' });
  }

  const result = db.prepare('INSERT INTO clans (name, leader_character_id) VALUES (?, ?)').run(name, req.character.id);
  db.prepare('UPDATE characters SET clan_id = ? WHERE id = ?').run(result.lastInsertRowid, req.character.id);

  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({ success: true, character: serializeCharacter(updated) });
});

router.post('/join', requireAuth, requireCharacter, (req, res) => {
  const { clanId } = req.body;
  const clan = db.prepare('SELECT * FROM clans WHERE id = ?').get(clanId);
  if (!clan) {
    return res.status(404).json({ error: 'Clan not found.' });
  }
  if (req.character.clan_id) {
    return res.status(400).json({ error: 'You are already in a clan. Leave it first.' });
  }

  db.prepare('UPDATE characters SET clan_id = ? WHERE id = ?').run(clanId, req.character.id);
  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({ success: true, character: serializeCharacter(updated) });
});

router.post('/leave', requireAuth, requireCharacter, (req, res) => {
  if (!req.character.clan_id) {
    return res.status(400).json({ error: 'You are not in a clan.' });
  }
  db.prepare('UPDATE characters SET clan_id = NULL WHERE id = ?').run(req.character.id);
  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({ success: true, character: serializeCharacter(updated) });
});

router.get('/:id/roster', requireAuth, (req, res) => {
  const members = db.prepare('SELECT id, name, level FROM characters WHERE clan_id = ? ORDER BY level DESC').all(req.params.id);
  res.json({ members });
});

module.exports = router;
