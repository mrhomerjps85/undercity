const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');

const router = express.Router();

router.get('/', requireAuth, requireCharacter, (req, res) => {
  const titles = db.prepare('SELECT * FROM title_templates ORDER BY price ASC').all();
  const owned = db.prepare('SELECT title_template_id FROM character_titles WHERE character_id = ?').all(req.character.id);
  const ownedIds = new Set(owned.map((o) => o.title_template_id));

  const result = titles.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    price: t.price,
    owned: ownedIds.has(t.id),
  }));

  res.json({ titles: result, activeTitleId: req.character.active_title_id });
});

router.post('/purchase', requireAuth, requireCharacter, (req, res) => {
  const { titleId } = req.body;
  const title = db.prepare('SELECT * FROM title_templates WHERE id = ?').get(titleId);
  if (!title) {
    return res.status(404).json({ error: 'Title not found.' });
  }
  const already = db.prepare('SELECT id FROM character_titles WHERE character_id = ? AND title_template_id = ?').get(req.character.id, titleId);
  if (already) {
    return res.status(400).json({ error: 'You already own that title.' });
  }
  if (req.character.gold < title.price) {
    return res.status(400).json({ error: `Not enough gold. ${title.name} costs ${title.price.toLocaleString()}.` });
  }

  db.prepare('UPDATE characters SET gold = gold - ? WHERE id = ?').run(title.price, req.character.id);
  db.prepare('INSERT INTO character_titles (character_id, title_template_id) VALUES (?, ?)').run(req.character.id, titleId);

  const updated = db.prepare('SELECT gold FROM characters WHERE id = ?').get(req.character.id);
  res.json({ success: true, gold: updated.gold });
});

router.post('/activate', requireAuth, requireCharacter, (req, res) => {
  const { titleId } = req.body;
  if (titleId === null) {
    db.prepare('UPDATE characters SET active_title_id = NULL WHERE id = ?').run(req.character.id);
    return res.json({ success: true, activeTitleId: null });
  }

  const owned = db.prepare('SELECT id FROM character_titles WHERE character_id = ? AND title_template_id = ?').get(req.character.id, titleId);
  if (!owned) {
    return res.status(400).json({ error: "You don't own that title." });
  }
  db.prepare('UPDATE characters SET active_title_id = ? WHERE id = ?').run(titleId, req.character.id);
  res.json({ success: true, activeTitleId: titleId });
});

module.exports = router;
