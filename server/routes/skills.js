const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const { SKILL_DEFINITIONS, MAX_SKILL_LEVEL, costForLevel, getCharacterSkillLevels, upgradeSkill } = require('../skills');
const { serializeCharacter } = require('./character');

const router = express.Router();

router.get('/', requireAuth, requireCharacter, (req, res) => {
  const levels = getCharacterSkillLevels(req.character.id);
  const skills = Object.entries(SKILL_DEFINITIONS).map(([skillType, def]) => {
    const level = levels[skillType];
    const atCap = level >= MAX_SKILL_LEVEL;
    return {
      skillType,
      name: def.name,
      description: def.description,
      image: def.image,
      level,
      maxLevel: MAX_SKILL_LEVEL,
      atCap,
      currentBonus: level > 0 ? def.bonusAtLevel(level) : 0,
      nextLevelBonus: atCap ? null : def.bonusAtLevel(level + 1),
      nextLevelCost: atCap ? null : costForLevel(level + 1),
    };
  });
  res.json({ skills });
});

router.post('/upgrade', requireAuth, requireCharacter, (req, res) => {
  const { skillType } = req.body;
  const def = SKILL_DEFINITIONS[skillType];
  if (!def) {
    return res.status(404).json({ error: 'Unknown skill.' });
  }

  const levels = getCharacterSkillLevels(req.character.id);
  const currentLevel = levels[skillType];
  if (currentLevel >= MAX_SKILL_LEVEL) {
    return res.status(400).json({ error: 'This skill is already at max level.' });
  }

  const cost = costForLevel(currentLevel + 1);
  if (req.character.gold < cost) {
    return res.status(400).json({ error: `Not enough gold - need ${cost.toLocaleString()}.` });
  }

  db.prepare('UPDATE characters SET gold = gold - ? WHERE id = ?').run(cost, req.character.id);
  const newLevel = upgradeSkill(req.character.id, skillType);

  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({ success: true, newLevel, character: serializeCharacter(updated) });
});

module.exports = router;
