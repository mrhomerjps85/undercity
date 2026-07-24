const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');

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

// Every quest the character hasn't accepted/completed yet - including ones they don't
// qualify for. Locked ones (level too low, or prerequisite not done) are marked with
// `locked: true` and a `lockReason` so players can see what's coming (e.g. the dungeon
// quest line) rather than having it simply not appear.
router.get('/available', requireAuth, requireCharacter, (req, res) => {
  const quests = db.prepare(`
    SELECT qt.*, mt.name as monster_name, it.name as item_name, zo.name as zone_name
    FROM quest_templates qt
    LEFT JOIN monster_templates mt ON mt.id = qt.target_monster_template_id
    LEFT JOIN item_templates it ON it.id = qt.target_item_template_id
    LEFT JOIN zones zo ON zo.id = qt.zone_id
    WHERE qt.id NOT IN (SELECT quest_template_id FROM character_quests WHERE character_id = ?)
  `).all(req.character.id);

  const completedIds = new Set(
    db.prepare(`SELECT quest_template_id FROM character_quests WHERE character_id = ? AND status = 'completed'`)
      .all(req.character.id).map(r => r.quest_template_id)
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
    return annotateQuestExtras({ ...q, locked: !!lockReason, lockReason });
  });

  // Show unlocked quests first, then locked ones (sorted by level) so upcoming content is visible but out of the way.
  annotated.sort((a, b) => (a.locked === b.locked ? a.min_level - b.min_level : a.locked ? 1 : -1));
  res.json({ quests: annotated });
});

router.get('/active', requireAuth, requireCharacter, (req, res) => {
  const quests = db.prepare(`
    SELECT cq.id as character_quest_id, cq.progress_count, cq.status, cq.completed_at,
           qt.*, mt.name as monster_name, it.name as item_name, zo.name as zone_name
    FROM character_quests cq
    JOIN quest_templates qt ON qt.id = cq.quest_template_id
    LEFT JOIN monster_templates mt ON mt.id = qt.target_monster_template_id
    LEFT JOIN item_templates it ON it.id = qt.target_item_template_id
    LEFT JOIN zones zo ON zo.id = qt.zone_id
    WHERE cq.character_id = ?
    ORDER BY cq.status ASC, cq.started_at DESC
  `).all(req.character.id);
  res.json({ quests: quests.map(annotateQuestExtras) });
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
  if (quest.prerequisite_quest_id) {
    const prereqDone = db.prepare(`
      SELECT id FROM character_quests WHERE character_id = ? AND quest_template_id = ? AND status = 'completed'
    `).get(req.character.id, quest.prerequisite_quest_id);
    if (!prereqDone) {
      return res.status(400).json({ error: 'You must complete the previous quest in this line first.' });
    }
  }
  const existing = db.prepare('SELECT id FROM character_quests WHERE character_id = ? AND quest_template_id = ?').get(req.character.id, questTemplateId);
  if (existing) {
    return res.status(400).json({ error: 'You already have this quest.' });
  }

  db.prepare('INSERT INTO character_quests (character_id, quest_template_id) VALUES (?, ?)').run(req.character.id, questTemplateId);
  res.json({ success: true });
});

module.exports = router;
