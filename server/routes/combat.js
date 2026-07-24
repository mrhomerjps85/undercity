const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const { computeDerivedStats, applyExpGain, resolveCombat, respawnSeconds } = require('../gameLogic');
const { getEquippedBonuses, serializeCharacter, getEquippedWeaponRarity } = require('./character');
const { progressKillQuests, progressCollectQuests, hasActiveCollectQuestFor } = require('../quests');

const router = express.Router();

// Roll the monster's drop table. Quest items only roll if the character has a
// matching active collect-quest, so random players don't get flooded with them.
function rollDrops(characterId, monsterTemplateId) {
  const drops = db.prepare(`
    SELECT md.*, it.name, it.is_quest_item FROM monster_drops md
    JOIN item_templates it ON it.id = md.item_template_id
    WHERE md.monster_template_id = ?
  `).all(monsterTemplateId);

  const dropped = [];
  for (const drop of drops) {
    if (drop.is_quest_item && !hasActiveCollectQuestFor(characterId, drop.item_template_id)) {
      continue;
    }
    if (Math.random() <= drop.drop_chance) {
      db.prepare('INSERT INTO character_inventory (character_id, item_template_id) VALUES (?, ?)').run(characterId, drop.item_template_id);
      dropped.push(drop.name);
      // Let quest tracking know an item was picked up, in case it completes a collect quest.
      progressCollectQuests(characterId, drop.item_template_id);
    }
  }
  return dropped;
}

router.post('/attack', requireAuth, requireCharacter, (req, res) => {
  const { roomMonsterId } = req.body;
  if (!roomMonsterId) {
    return res.status(400).json({ error: 'roomMonsterId is required.' });
  }

  const roomMonster = db.prepare(`
    SELECT rm.id as room_monster_id, rm.room_id, rm.is_alive, mt.*
    FROM room_monsters rm
    JOIN monster_templates mt ON mt.id = rm.monster_template_id
    WHERE rm.id = ?
  `).get(roomMonsterId);

  if (!roomMonster || !roomMonster.is_alive) {
    return res.status(404).json({ error: 'That monster is no longer here.' });
  }
  if (roomMonster.room_id !== req.character.current_room_id) {
    return res.status(400).json({ error: 'That monster is not in your current room.' });
  }

  const character = req.character;
  const bonuses = getEquippedBonuses(character.id);
  const derived = computeDerivedStats(character, bonuses);
  const characterStats = { maxHp: derived.maxHp, attack: derived.attack };
  const weaponRarity = getEquippedWeaponRarity(character.id);

  const result = resolveCombat(characterStats, roomMonster, weaponRarity);

  db.prepare(`
    INSERT INTO combat_log (character_id, monster_name, result, exp_gained, gold_gained)
    VALUES (?, ?, ?, ?, ?)
  `).run(character.id, roomMonster.name, result.victory ? 'victory' : 'defeat', result.expGained, result.goldGained);

  let leveledUp = false;
  let levelsGained = 0;
  let droppedItems = [];
  let completedQuests = [];

  if (result.victory) {
    const updatedChar = { ...character };
    const expResult = applyExpGain(updatedChar, result.expGained);
    leveledUp = expResult.leveledUp;
    levelsGained = expResult.levelsGained;

    db.prepare(`
      UPDATE characters
      SET exp = ?, level = ?, attack_points = ?, hp_points = ?, gold = gold + ?, current_hp = ?
      WHERE id = ?
    `).run(updatedChar.exp, updatedChar.level, updatedChar.attack_points, updatedChar.hp_points, result.goldGained, result.hpRemaining, character.id);

    // Monster respawns after a delay scaled to its level.
    const respawnAt = new Date(Date.now() + respawnSeconds(roomMonster.level) * 1000).toISOString();
    db.prepare('UPDATE room_monsters SET is_alive = 0, respawn_at = ? WHERE id = ?').run(respawnAt, roomMonster.room_monster_id);

    droppedItems = rollDrops(character.id, roomMonster.id);
    completedQuests = progressKillQuests(character.id, roomMonster.id);

    // Quest rewards may have added exp/gold outside the applyExpGain loop above;
    // re-check for any level-ups that unlocks now that exp has been topped up.
    if (completedQuests.length > 0) {
      const afterQuestChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(character.id);
      const followUp = applyExpGain(afterQuestChar, 0);
      if (followUp.leveledUp) {
        leveledUp = true;
        levelsGained += followUp.levelsGained;
        db.prepare('UPDATE characters SET exp = ?, level = ?, attack_points = ?, hp_points = ? WHERE id = ?')
          .run(afterQuestChar.exp, afterQuestChar.level, afterQuestChar.attack_points, afterQuestChar.hp_points, character.id);
      }
    }
  } else {
    db.prepare('UPDATE characters SET current_hp = ? WHERE id = ?').run(result.hpRemaining, character.id);
  }

  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(character.id);

  res.json({
    log: result.log,
    victory: result.victory,
    expGained: result.expGained,
    goldGained: result.goldGained,
    crits: result.crits,
    leveledUp,
    levelsGained,
    droppedItems,
    completedQuests,
    character: serializeCharacter(updated),
  });
});

// Recent fight history - the combat_log table is already written to on every attack;
// this just surfaces it for the "Recent Battles" list on the Character sheet.
router.get('/history', requireAuth, requireCharacter, (req, res) => {
  const entries = db.prepare(`
    SELECT monster_name, result, exp_gained, gold_gained, created_at
    FROM combat_log WHERE character_id = ? ORDER BY id DESC LIMIT 50
  `).all(req.character.id);
  res.json({ entries });
});

module.exports = router;
