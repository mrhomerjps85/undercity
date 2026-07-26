const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const { getOrCreateGenerationalItem, GENERATION_KILL_SCALE } = require('../quests');

const router = express.Router();

// Finds where a monster template actually spawns (room + zone), so quests can tell
// players where to go instead of leaving them to search a 9x9 grid blind. Capped at a
// handful of distinct rooms - a monster might spawn in many rooms, but a short list is
// more useful than an exhaustive one.
function getMonsterLocations(monsterTemplateId, limit = 4) {
  if (!monsterTemplateId) return [];
  return db.prepare(`
    SELECT DISTINCT r.name as room_name, z.name as zone_name
    FROM room_monsters rm
    JOIN rooms r ON r.id = rm.room_id
    JOIN zones z ON z.id = r.zone_id
    WHERE rm.monster_template_id = ?
    LIMIT ?
  `).all(monsterTemplateId, limit);
}

// For collect quests, the "location" is really "where does the dropping monster spawn" -
// resolve through monster_drops to find who drops this item, then locate them.
function getItemDropLocations(itemTemplateId, limit = 4) {
  if (!itemTemplateId) return [];
  const droppers = db.prepare(`
    SELECT DISTINCT mt.id, mt.name FROM monster_drops md
    JOIN monster_templates mt ON mt.id = md.monster_template_id
    WHERE md.item_template_id = ?
  `).all(itemTemplateId);

  const locations = [];
  for (const dropper of droppers) {
    const rooms = getMonsterLocations(dropper.id, limit);
    rooms.forEach(r => locations.push({ ...r, monster_name: dropper.name }));
    if (locations.length >= limit) break;
  }
  return locations.slice(0, limit);
}

// Attaches location info and a full reward-item preview (name/slot/stats/rarity/image)
// to a raw quest row - shared by both /available and /active so the shape stays consistent.
// The reward preview always shows the base (generation 0) item - the actual generational
// version only gets created once the quest is genuinely completed at that generation.
function annotateQuestExtras(q) {
  const locations = q.type === 'collect'
    ? getItemDropLocations(q.target_item_template_id)
    : getMonsterLocations(q.target_monster_template_id);

  let rewardItem = null;
  if (q.reward_item_template_id) {
    rewardItem = db.prepare(`
      SELECT it.name, it.slot, it.bonus_atk, it.bonus_hp, it.rarity, it.image, iset.name as set_name
      FROM item_templates it
      LEFT JOIN item_sets iset ON iset.id = it.set_id
      WHERE it.id = ?
    `).get(q.reward_item_template_id);
  }

  return { ...q, locations, rewardItem };
}

// Every quest the character hasn't accepted/completed *in their current rebirth
// generation* yet - including ones they don't qualify for. A quest completed in a PAST
// generation shows up here again (rebirthing is what makes questing worthwhile to redo),
// while one completed in the CURRENT generation or currently active does not.
router.get('/available', requireAuth, requireCharacter, (req, res) => {
  const generation = req.character.rebirth_count;

  const quests = db.prepare(`
    SELECT qt.*, mt.name as monster_name, it.name as item_name, zo.name as zone_name
    FROM quest_templates qt
    LEFT JOIN monster_templates mt ON mt.id = qt.target_monster_template_id
    LEFT JOIN item_templates it ON it.id = qt.target_item_template_id
    LEFT JOIN zones zo ON zo.id = qt.zone_id
    WHERE qt.id NOT IN (
      SELECT quest_template_id FROM character_quests
      WHERE character_id = ? AND (status = 'active' OR (status = 'completed' AND generation = ?))
    )
  `).all(req.character.id, generation);

  // Only counts a prerequisite as satisfied if it was completed in THIS generation - each
  // rebirth means redoing the chain in order again, not skipping straight to the finale
  // on the strength of a completion from several rebirths ago.
  const completedIds = new Set(
    db.prepare(`SELECT quest_template_id FROM character_quests WHERE character_id = ? AND status = 'completed' AND generation = ?`)
      .all(req.character.id, generation).map(r => r.quest_template_id)
  );

  const prereqNamesById = new Map(
    db.prepare('SELECT id, name FROM quest_templates').all().map(q => [q.id, q.name])
  );

  const annotated = quests.map(q => {
    const prereqMet = !q.prerequisite_quest_id || completedIds.has(q.prerequisite_quest_id);
    const levelMet = req.character.level >= q.min_level;
    let lockReason = null;
    if (!prereqMet) {
      lockReason = `Requires completing "${prereqNamesById.get(q.prerequisite_quest_id)}" first`;
    } else if (!levelMet) {
      lockReason = `Requires level ${q.min_level}`;
    }
    // Preview of what accepting NOW would actually require/pay, at the character's
    // current generation - overwriting these (not adding new fields) means the existing
    // frontend rendering, which already reads required_count/reward_exp/reward_gold,
    // shows the correct scaled numbers with no changes needed on that side.
    const effectiveRequiredCount = Math.ceil(q.required_count * (1 + generation * GENERATION_KILL_SCALE));
    const scaleRatio = effectiveRequiredCount / q.required_count;
    return annotateQuestExtras({
      ...q,
      locked: !!lockReason,
      lockReason,
      generation,
      required_count: effectiveRequiredCount,
      reward_exp: Math.round(q.reward_exp * scaleRatio),
      reward_gold: Math.round(q.reward_gold * scaleRatio),
    });
  });

  // Show unlocked quests first, then locked ones (sorted by level) so upcoming content is visible but out of the way.
  annotated.sort((a, b) => (a.locked === b.locked ? a.min_level - b.min_level : a.locked ? 1 : -1));
  res.json({ quests: annotated });
});

// Only the CURRENT generation's active/completed quests - past-generation history stays
// in the database (for the record) but doesn't clutter this list with stale entries.
router.get('/active', requireAuth, requireCharacter, (req, res) => {
  const quests = db.prepare(`
    SELECT cq.id as character_quest_id, cq.progress_count, cq.status, cq.completed_at, cq.generation,
           cq.effective_required_count, cq.effective_reward_exp, cq.effective_reward_gold,
           qt.*, mt.name as monster_name, it.name as item_name, zo.name as zone_name
    FROM character_quests cq
    JOIN quest_templates qt ON qt.id = cq.quest_template_id
    LEFT JOIN monster_templates mt ON mt.id = qt.target_monster_template_id
    LEFT JOIN item_templates it ON it.id = qt.target_item_template_id
    LEFT JOIN zones zo ON zo.id = qt.zone_id
    WHERE cq.character_id = ? AND cq.generation = ?
    ORDER BY cq.status ASC, cq.started_at DESC
  `).all(req.character.id, req.character.rebirth_count);

  res.json({
    quests: quests.map((q) => annotateQuestExtras({
      ...q,
      required_count: q.effective_required_count, // the actual number that matters for this attempt
      reward_exp: q.effective_reward_exp,
      reward_gold: q.effective_reward_gold,
    })),
  });
});

router.post('/accept', requireAuth, requireCharacter, (req, res) => {
  const { questTemplateId } = req.body;
  const quest = db.prepare('SELECT * FROM quest_templates WHERE id = ?').get(questTemplateId);
  if (!quest) {
    return res.status(404).json({ error: 'Quest not found.' });
  }
  if (req.character.level < quest.min_level) {
    return res.status(400).json({ error: `Requires level ${quest.min_level}.` });
  }

  const generation = req.character.rebirth_count;

  if (quest.prerequisite_quest_id) {
    const prereqDone = db.prepare(`
      SELECT id FROM character_quests WHERE character_id = ? AND quest_template_id = ? AND status = 'completed' AND generation = ?
    `).get(req.character.id, quest.prerequisite_quest_id, generation);
    if (!prereqDone) {
      return res.status(400).json({ error: 'You must complete the previous quest in this line first.' });
    }
  }

  // Blocks re-accepting if already active, or already completed THIS generation - but a
  // completion from a PAST generation (before the character's most recent rebirth) does
  // not block a fresh attempt now.
  const existing = db.prepare(`
    SELECT id FROM character_quests WHERE character_id = ? AND quest_template_id = ? AND (status = 'active' OR generation = ?)
  `).get(req.character.id, questTemplateId, generation);
  if (existing) {
    return res.status(400).json({ error: 'You already have this quest.' });
  }

  const effectiveRequiredCount = Math.ceil(quest.required_count * (1 + generation * GENERATION_KILL_SCALE));

  // Reward scales from the same "3x the target monster's reward" policy used everywhere
  // else in the game, computed against the SCALED required count - so a harder repeat
  // attempt pays proportionally more, not the same flat amount for more work.
  let baseMonster = null;
  if (quest.type === 'kill' && quest.target_monster_template_id) {
    baseMonster = db.prepare('SELECT exp_reward, gold_reward FROM monster_templates WHERE id = ?').get(quest.target_monster_template_id);
  } else if (quest.type === 'collect' && quest.target_item_template_id) {
    baseMonster = db.prepare(`
      SELECT mt.exp_reward, mt.gold_reward FROM monster_drops md
      JOIN monster_templates mt ON mt.id = md.monster_template_id
      WHERE md.item_template_id = ? LIMIT 1
    `).get(quest.target_item_template_id);
  }

  let effectiveRewardExp;
  let effectiveRewardGold;
  if (baseMonster) {
    effectiveRewardExp = Math.round(baseMonster.exp_reward * effectiveRequiredCount * 3);
    effectiveRewardGold = Math.round(baseMonster.gold_reward * effectiveRequiredCount * 3);
  } else {
    // No monster to derive from (shouldn't normally happen) - fall back to scaling the
    // template's own flat reward by the same ratio the required count grew by.
    const scaleRatio = effectiveRequiredCount / quest.required_count;
    effectiveRewardExp = Math.round(quest.reward_exp * scaleRatio);
    effectiveRewardGold = Math.round(quest.reward_gold * scaleRatio);
  }

  const grantedItemTemplateId = getOrCreateGenerationalItem(quest.reward_item_template_id, generation);

  db.prepare(`
    INSERT INTO character_quests
      (character_id, quest_template_id, generation, effective_required_count, effective_reward_exp, effective_reward_gold, granted_item_template_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.character.id, questTemplateId, generation, effectiveRequiredCount, effectiveRewardExp, effectiveRewardGold, grantedItemTemplateId);

  let tutorialStep = req.character.tutorial_step;
  if (tutorialStep === 3) {
    tutorialStep = 4;
    db.prepare('UPDATE characters SET tutorial_step = 4 WHERE id = ?').run(req.character.id);
  }

  res.json({ success: true, tutorialStep });
});

module.exports = router;
