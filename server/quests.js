// quests.js - Shared quest progress logic used by both combat.js (kill/collect triggers)
// and routes/quests.js (accepting/listing quests).
const db = require('./db/db');

// Rebirth-generation scaling for repeat quest completions - required kills and rewards
// scale up together (rewards stay proportional since they're computed from the effective
// required count, not looked up separately), item rewards get a distinct, more powerful
// version rather than a duplicate of the original.
const GENERATION_KILL_SCALE = 0.25;
const GENERATION_ITEM_STAT_SCALE = 0.25;

// Returns the item_template_id to actually grant for a given base reward item at a given
// generation. Generation 0 is just the original item, unchanged. Generation 1+ gets a
// separate "(Gen N)" item created the first time it's ever needed and reused after that
// (via the same name-uniqueness the rest of the seeded item catalog relies on) - never a
// duplicate of the original, so repeat completions can't grant the same unique item twice.
function getOrCreateGenerationalItem(baseItemTemplateId, generation) {
  if (!baseItemTemplateId || generation <= 0) return baseItemTemplateId;

  const base = db.prepare('SELECT * FROM item_templates WHERE id = ?').get(baseItemTemplateId);
  if (!base) return baseItemTemplateId;

  const genName = `${base.name} (Gen ${generation})`;
  const existing = db.prepare('SELECT id FROM item_templates WHERE name = ?').get(genName);
  if (existing) return existing.id;

  const mult = 1 + generation * GENERATION_ITEM_STAT_SCALE;
  const result = db.prepare(`
    INSERT INTO item_templates (name, slot, required_level, bonus_atk, bonus_hp, price, source, is_quest_item, rarity, set_id, image)
    VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)
  `).run(
    genName, base.slot, base.required_level,
    Math.round(base.bonus_atk * mult), Math.round(base.bonus_hp * mult),
    base.source, base.rarity, base.set_id, base.image
  );
  return result.lastInsertRowid;
}

// Call after a monster is defeated. Increments progress on any active 'kill' quests
// targeting that monster template, and auto-completes + grants rewards when done.
// Returns an array of { quest, reward } for any quests completed by this kill.
function progressKillQuests(characterId, monsterTemplateId) {
  const activeKillQuests = db.prepare(`
    SELECT cq.*, qt.name
    FROM character_quests cq
    JOIN quest_templates qt ON qt.id = cq.quest_template_id
    WHERE cq.character_id = ? AND cq.status = 'active' AND qt.type = 'kill' AND qt.target_monster_template_id = ?
  `).all(characterId, monsterTemplateId);

  const completed = [];
  for (const cq of activeKillQuests) {
    const requiredCount = cq.effective_required_count;
    const newProgress = Math.min(cq.progress_count + 1, requiredCount);
    const isDone = newProgress >= requiredCount;
    db.prepare(`UPDATE character_quests SET progress_count = ?, status = ?, completed_at = ? WHERE id = ?`)
      .run(newProgress, isDone ? 'completed' : 'active', isDone ? new Date().toISOString() : null, cq.id);
    if (isDone) {
      grantQuestReward(characterId, cq);
      completed.push({ questName: cq.name, rewardExp: cq.effective_reward_exp, rewardGold: cq.effective_reward_gold, rewardItemTemplateId: cq.granted_item_template_id });
    }
  }
  return completed;
}

// Call after an item drops for a character. Increments progress on any active 'collect'
// quests targeting that item template, and auto-completes when the required count is reached
// (consuming the collected quest items from inventory).
function progressCollectQuests(characterId, itemTemplateId) {
  const activeCollectQuests = db.prepare(`
    SELECT cq.*, qt.name, qt.target_item_template_id
    FROM character_quests cq
    JOIN quest_templates qt ON qt.id = cq.quest_template_id
    WHERE cq.character_id = ? AND cq.status = 'active' AND qt.type = 'collect' AND qt.target_item_template_id = ?
  `).all(characterId, itemTemplateId);

  const completed = [];
  for (const cq of activeCollectQuests) {
    const requiredCount = cq.effective_required_count;
    const newProgress = Math.min(cq.progress_count + 1, requiredCount);
    const isDone = newProgress >= requiredCount;
    db.prepare(`UPDATE character_quests SET progress_count = ?, status = ?, completed_at = ? WHERE id = ?`)
      .run(newProgress, isDone ? 'completed' : 'active', isDone ? new Date().toISOString() : null, cq.id);
    if (isDone) {
      // Consume the collected quest items from inventory.
      const owned = db.prepare(`
        SELECT id FROM character_inventory WHERE character_id = ? AND item_template_id = ? LIMIT ?
      `).all(characterId, itemTemplateId, requiredCount);
      for (const row of owned) {
        db.prepare('DELETE FROM character_inventory WHERE id = ?').run(row.id);
      }
      grantQuestReward(characterId, cq);
      completed.push({ questName: cq.name, rewardExp: cq.effective_reward_exp, rewardGold: cq.effective_reward_gold, rewardItemTemplateId: cq.granted_item_template_id });
    }
  }
  return completed;
}

function grantQuestReward(characterId, cq) {
  db.prepare('UPDATE characters SET exp = exp + ?, gold = gold + ? WHERE id = ?')
    .run(cq.effective_reward_exp || 0, cq.effective_reward_gold || 0, characterId);
  if (cq.granted_item_template_id) {
    db.prepare('INSERT INTO character_inventory (character_id, item_template_id) VALUES (?, ?)')
      .run(characterId, cq.granted_item_template_id);
  }
}

// Whether a character has an active 'collect' quest that wants this specific item.
// Used by combat.js to decide whether to even roll a quest-item drop.
function hasActiveCollectQuestFor(characterId, itemTemplateId) {
  const row = db.prepare(`
    SELECT cq.id FROM character_quests cq
    JOIN quest_templates qt ON qt.id = cq.quest_template_id
    WHERE cq.character_id = ? AND cq.status = 'active' AND qt.type = 'collect' AND qt.target_item_template_id = ?
    LIMIT 1
  `).get(characterId, itemTemplateId);
  return !!row;
}

module.exports = {
  progressKillQuests, progressCollectQuests, grantQuestReward, hasActiveCollectQuestFor,
  getOrCreateGenerationalItem, GENERATION_KILL_SCALE,
};
