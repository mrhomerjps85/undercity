// quests.js - Shared quest progress logic used by both combat.js (kill/collect triggers)
// and routes/quests.js (accepting/listing quests).
const db = require('./db/db');

// Call after a monster is defeated. Increments progress on any active 'kill' quests
// targeting that monster template, and auto-completes + grants rewards when done.
// Returns an array of { quest, reward } for any quests completed by this kill.
function progressKillQuests(characterId, monsterTemplateId) {
  const activeKillQuests = db.prepare(`
    SELECT cq.*, qt.required_count, qt.reward_exp, qt.reward_gold, qt.reward_item_template_id, qt.name
    FROM character_quests cq
    JOIN quest_templates qt ON qt.id = cq.quest_template_id
    WHERE cq.character_id = ? AND cq.status = 'active' AND qt.type = 'kill' AND qt.target_monster_template_id = ?
  `).all(characterId, monsterTemplateId);

  const completed = [];
  for (const cq of activeKillQuests) {
    const newProgress = Math.min(cq.progress_count + 1, cq.required_count);
    const isDone = newProgress >= cq.required_count;
    db.prepare(`UPDATE character_quests SET progress_count = ?, status = ?, completed_at = ? WHERE id = ?`)
      .run(newProgress, isDone ? 'completed' : 'active', isDone ? new Date().toISOString() : null, cq.id);
    if (isDone) {
      grantQuestReward(characterId, cq);
      completed.push({ questName: cq.name, rewardExp: cq.reward_exp, rewardGold: cq.reward_gold, rewardItemTemplateId: cq.reward_item_template_id });
    }
  }
  return completed;
}

// Call after an item drops for a character. Increments progress on any active 'collect'
// quests targeting that item template, and auto-completes when the required count is reached
// (consuming the collected quest items from inventory).
function progressCollectQuests(characterId, itemTemplateId) {
  const activeCollectQuests = db.prepare(`
    SELECT cq.*, qt.required_count, qt.reward_exp, qt.reward_gold, qt.reward_item_template_id, qt.name, qt.target_item_template_id
    FROM character_quests cq
    JOIN quest_templates qt ON qt.id = cq.quest_template_id
    WHERE cq.character_id = ? AND cq.status = 'active' AND qt.type = 'collect' AND qt.target_item_template_id = ?
  `).all(characterId, itemTemplateId);

  const completed = [];
  for (const cq of activeCollectQuests) {
    const newProgress = Math.min(cq.progress_count + 1, cq.required_count);
    const isDone = newProgress >= cq.required_count;
    db.prepare(`UPDATE character_quests SET progress_count = ?, status = ?, completed_at = ? WHERE id = ?`)
      .run(newProgress, isDone ? 'completed' : 'active', isDone ? new Date().toISOString() : null, cq.id);
    if (isDone) {
      // Consume the collected quest items from inventory.
      const owned = db.prepare(`
        SELECT id FROM character_inventory WHERE character_id = ? AND item_template_id = ? LIMIT ?
      `).all(characterId, itemTemplateId, cq.required_count);
      for (const row of owned) {
        db.prepare('DELETE FROM character_inventory WHERE id = ?').run(row.id);
      }
      grantQuestReward(characterId, cq);
      completed.push({ questName: cq.name, rewardExp: cq.reward_exp, rewardGold: cq.reward_gold, rewardItemTemplateId: cq.reward_item_template_id });
    }
  }
  return completed;
}

function grantQuestReward(characterId, cq) {
  db.prepare('UPDATE characters SET exp = exp + ?, gold = gold + ? WHERE id = ?')
    .run(cq.reward_exp || 0, cq.reward_gold || 0, characterId);
  if (cq.reward_item_template_id) {
    db.prepare('INSERT INTO character_inventory (character_id, item_template_id) VALUES (?, ?)')
      .run(characterId, cq.reward_item_template_id);
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

module.exports = { progressKillQuests, progressCollectQuests, grantQuestReward, hasActiveCollectQuestFor };
