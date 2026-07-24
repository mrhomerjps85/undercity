const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const { computeDerivedStats, estimateWinProbability } = require('../gameLogic');

const router = express.Router();

// Flip any due monsters in this room back to alive before reading the room's monster list.
function processRespawns(roomId) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE room_monsters
    SET is_alive = 1, respawn_at = NULL
    WHERE room_id = ? AND is_alive = 0 AND respawn_at IS NOT NULL AND respawn_at <= ?
  `).run(roomId, now);
}

function getRoomDetails(roomId, character) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) return null;
  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(room.zone_id);

  processRespawns(roomId);

  const rawMonsters = db.prepare(`
    SELECT rm.id as room_monster_id, mt.id as template_id, mt.name, mt.level, mt.max_hp, mt.attack, mt.defense, mt.image
    FROM room_monsters rm
    JOIN monster_templates mt ON mt.id = rm.monster_template_id
    WHERE rm.room_id = ? AND rm.is_alive = 1
  `).all(roomId);

  // Annotate each monster with an Easy/Risky/Deadly badge, estimated from the character's
  // current stats vs. that monster, so players can gauge a fight before committing to it.
  let monsters = rawMonsters;
  if (character) {
    const { getEquippedBonuses, getEquippedWeaponRarity } = require('./character');
    const bonuses = getEquippedBonuses(character.id);
    const derived = computeDerivedStats(character, bonuses);
    const weaponRarity = getEquippedWeaponRarity(character.id);
    const characterStats = { maxHp: derived.maxHp, attack: derived.attack };
    monsters = rawMonsters.map(m => {
      const { winRate, difficulty } = estimateWinProbability(characterStats, m, weaponRarity, 20);
      const { attack, defense, ...rest } = m; // don't leak the monster's raw combat stats to the client
      return { ...rest, winRate: Math.round(winRate * 100), difficulty };
    });
  }

  const respawningCount = db.prepare(`
    SELECT COUNT(*) as c FROM room_monsters WHERE room_id = ? AND is_alive = 0
  `).get(roomId).c;

  // Other players currently standing in this room (for the "shared world" feel)
  const otherPlayers = db.prepare(`
    SELECT id, name, level FROM characters WHERE current_room_id = ? AND id != ?
  `).all(roomId, (character && character.id) || -1);

  // World boss, if this room has one (lazily processes its respawn timer too).
  let worldBoss = null;
  try {
    const { getBossForRoom, serializeBoss } = require('./worldboss');
    const boss = getBossForRoom(roomId);
    if (boss) worldBoss = serializeBoss(boss);
  } catch {
    // worldboss module not available for some reason - room still works without it.
  }

  return {
    room,
    zone,
    monsters,
    respawningCount,
    otherPlayers,
    worldBoss,
    exits: {
      north: room.north_room_id,
      south: room.south_room_id,
      east: room.east_room_id,
      west: room.west_room_id,
    },
  };
}

router.get('/room/current', requireAuth, requireCharacter, (req, res) => {
  const details = getRoomDetails(req.character.current_room_id, req.character);
  res.json({ ...details, tutorialStep: req.character.tutorial_step });
});

router.post('/move', requireAuth, requireCharacter, (req, res) => {
  const { direction } = req.body; // 'north' | 'south' | 'east' | 'west'
  const validDirections = ['north', 'south', 'east', 'west'];
  if (!validDirections.includes(direction)) {
    return res.status(400).json({ error: 'Invalid direction.' });
  }

  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.character.current_room_id);
  const columnMap = { north: 'north_room_id', south: 'south_room_id', east: 'east_room_id', west: 'west_room_id' };
  const nextRoomId = room[columnMap[direction]];

  if (!nextRoomId) {
    return res.status(400).json({ error: "You can't go that way." });
  }

  db.prepare('UPDATE characters SET current_room_id = ? WHERE id = ?').run(nextRoomId, req.character.id);

  let tutorialStep = req.character.tutorial_step;
  if (tutorialStep === 1) {
    tutorialStep = 2;
    db.prepare('UPDATE characters SET tutorial_step = 2 WHERE id = ?').run(req.character.id);
  }

  const details = getRoomDetails(nextRoomId, req.character);
  res.json({ ...details, tutorialStep });
});

// List all zones (for the Travel list). Includes whether the character meets the level requirement.
router.get('/zones', requireAuth, requireCharacter, (req, res) => {
  const zones = db.prepare('SELECT * FROM zones ORDER BY is_dungeon ASC, min_level ASC').all();
  const withAccess = zones.map(z => ({ ...z, locked: req.character.level < z.min_level }));
  res.json({ zones: withAccess });
});

// Teleport to a zone's entrance room (like clicking a zone on the world map).
router.post('/teleport', requireAuth, requireCharacter, (req, res) => {
  const { zoneId } = req.body;
  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(zoneId);
  if (!zone) {
    return res.status(404).json({ error: 'Zone not found.' });
  }
  if (req.character.level < zone.min_level) {
    return res.status(400).json({ error: `Requires level ${zone.min_level}.` });
  }

  const entrance = db.prepare('SELECT id FROM rooms WHERE zone_id = ? AND is_entrance = 1 LIMIT 1').get(zoneId)
    || db.prepare('SELECT id FROM rooms WHERE zone_id = ? ORDER BY id ASC LIMIT 1').get(zoneId);

  db.prepare('UPDATE characters SET current_room_id = ? WHERE id = ?').run(entrance.id, req.character.id);
  const details = getRoomDetails(entrance.id, req.character);
  res.json(details);
});

module.exports = { router, getRoomDetails, processRespawns };
