const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const { computeDerivedStats, expToNextLevel, applyUpgradeMultiplier } = require('../gameLogic');

const router = express.Router();

// Aggregates equipped items' Attack/HP bonuses (scaled by each item's individual
// upgrade level) plus any set bonuses unlocked by equipping enough pieces of a set.
function getEquippedBonuses(characterId) {
  const items = db.prepare(`
    SELECT ci.upgrade_level, it.* FROM character_inventory ci
    JOIN item_templates it ON it.id = ci.item_template_id
    WHERE ci.character_id = ? AND ci.equipped = 1
  `).all(characterId);

  const totals = items.reduce((acc, it) => {
    acc.atk += applyUpgradeMultiplier(it.bonus_atk, it.upgrade_level);
    acc.hp += applyUpgradeMultiplier(it.bonus_hp, it.upgrade_level);
    return acc;
  }, { atk: 0, hp: 0 });

  // Count equipped pieces per set, then add the highest set bonus tier each set qualifies for.
  const setCounts = {};
  items.forEach(it => {
    if (it.set_id) setCounts[it.set_id] = (setCounts[it.set_id] || 0) + 1;
  });
  for (const [setId, count] of Object.entries(setCounts)) {
    const tiers = db.prepare('SELECT * FROM set_bonuses WHERE set_id = ? AND pieces_required <= ? ORDER BY pieces_required DESC LIMIT 1').get(setId, count);
    if (tiers) {
      totals.atk += tiers.bonus_atk;
      totals.hp += tiers.bonus_hp;
    }
  }

  return totals;
}

// Returns active set info for display: which sets are partially/fully equipped,
// how many pieces out of the set's total, and the bonus text for pieces owned/equipped.
function getActiveSetInfo(characterId) {
  const equippedItems = db.prepare(`
    SELECT it.set_id, it.id as item_id FROM character_inventory ci
    JOIN item_templates it ON it.id = ci.item_template_id
    WHERE ci.character_id = ? AND ci.equipped = 1 AND it.set_id IS NOT NULL
  `).all(characterId);

  const setIds = [...new Set(equippedItems.map(i => i.set_id))];
  return setIds.map(setId => {
    const set = db.prepare('SELECT * FROM item_sets WHERE id = ?').get(setId);
    const totalPieces = db.prepare('SELECT COUNT(*) c FROM item_templates WHERE set_id = ?').get(setId).c;
    const equippedCount = equippedItems.filter(i => i.set_id === setId).length;
    const bonusTiers = db.prepare('SELECT * FROM set_bonuses WHERE set_id = ? ORDER BY pieces_required ASC').all(setId);
    return { ...set, equippedCount, totalPieces, bonusTiers };
  });
}

// Returns the rarity of the character's currently equipped weapon ('unarmed' if none) -
// drives crit chance/multiplier in combat (see gameLogic.getCritConfig).
function getEquippedWeaponRarity(characterId) {
  const weapon = db.prepare(`
    SELECT it.rarity FROM character_inventory ci
    JOIN item_templates it ON it.id = ci.item_template_id
    WHERE ci.character_id = ? AND ci.equipped = 1 AND it.slot = 'weapon'
    LIMIT 1
  `).get(characterId);
  return weapon ? weapon.rarity : 'unarmed';
}

function serializeCharacter(character) {
  const bonuses = getEquippedBonuses(character.id);
  const derived = computeDerivedStats(character, bonuses);
  return {
    ...character,
    max_hp: derived.maxHp,
    attack: derived.attack,
    exp_to_next_level: expToNextLevel(character.level),
  };
}

router.post('/', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT id FROM characters WHERE user_id = ?').get(req.session.userId);
  if (existing) {
    return res.status(409).json({ error: 'You already have a character.' });
  }

  const { name } = req.body;
  if (!name || name.length < 2 || name.length > 20) {
    return res.status(400).json({ error: 'Character name must be 2-20 characters.' });
  }

  const nameTaken = db.prepare('SELECT id FROM characters WHERE name = ?').get(name);
  if (nameTaken) {
    return res.status(409).json({ error: 'That character name is already taken.' });
  }

  // Spawn point: the designated entrance room of the lowest-level non-dungeon zone.
  const spawnRoom = db.prepare(`
    SELECT r.id FROM rooms r
    JOIN zones z ON z.id = r.zone_id
    WHERE r.is_entrance = 1 AND z.is_dungeon = 0
    ORDER BY z.min_level ASC LIMIT 1
  `).get() || db.prepare('SELECT id FROM rooms ORDER BY id ASC LIMIT 1').get();

  const result = db.prepare(`
    INSERT INTO characters (user_id, name, current_room_id)
    VALUES (?, ?, ?)
  `).run(req.session.userId, name, spawnRoom.id);

  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(result.lastInsertRowid);
  res.json({ character: serializeCharacter(character) });
});

router.get('/me', requireAuth, requireCharacter, (req, res) => {
  res.json({ character: serializeCharacter(req.character) });
});

module.exports = { router, serializeCharacter, getEquippedBonuses, getActiveSetInfo, getEquippedWeaponRarity };
