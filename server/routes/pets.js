const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');

const router = express.Router();

router.get('/', requireAuth, requireCharacter, (req, res) => {
  const owned = db.prepare(`
    SELECT pt.id, pt.name, pt.rarity, pt.bonus_type, pt.bonus_value, pt.image, pt.description,
           COUNT(cp.id) as count
    FROM character_pets cp
    JOIN pet_templates pt ON pt.id = cp.pet_template_id
    WHERE cp.character_id = ?
    GROUP BY pt.id
    ORDER BY CASE pt.rarity
      WHEN 'mythic' THEN 0 WHEN 'legendary' THEN 1 WHEN 'epic' THEN 2
      WHEN 'rare' THEN 3 WHEN 'uncommon' THEN 4 ELSE 5 END, pt.name
  `).all(req.character.id);

  res.json({ pets: owned, activePetTemplateId: req.character.active_pet_template_id });
});

router.post('/activate', requireAuth, requireCharacter, (req, res) => {
  const { petTemplateId } = req.body;
  if (petTemplateId === null) {
    db.prepare('UPDATE characters SET active_pet_template_id = NULL WHERE id = ?').run(req.character.id);
    return res.json({ success: true, activePetTemplateId: null });
  }

  const owned = db.prepare('SELECT id FROM character_pets WHERE character_id = ? AND pet_template_id = ?').get(req.character.id, petTemplateId);
  if (!owned) {
    return res.status(400).json({ error: "You don't own that pet." });
  }
  db.prepare('UPDATE characters SET active_pet_template_id = ? WHERE id = ?').run(petTemplateId, req.character.id);
  res.json({ success: true, activePetTemplateId: petTemplateId });
});

module.exports = router;
