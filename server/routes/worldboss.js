const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const { computeDerivedStats, computeWorldBossDamage, WORLD_BOSS_ATTACK_COOLDOWN_SECONDS, applyExpGain } = require('../gameLogic');
const { getActivePotionEffects } = require('../potions');
const { getEquippedBonuses, serializeCharacter, getEquippedWeaponRarity } = require('./character');

const router = express.Router();

// Parses timestamps written via new Date().toISOString() OR sqlite's datetime('now') format.
function parseTimestamp(str) {
  if (!str) return 0;
  if (str.includes('T')) return new Date(str).getTime();
  return new Date(str.replace(' ', 'T') + 'Z').getTime();
}

function getIO() {
  try {
    return require('../socket').getIO();
  } catch {
    return null;
  }
}

// Flips a dead boss back to alive (new generation) once its respawn timer has passed.
function processRespawn(boss) {
  if (boss.is_alive || !boss.respawn_at) return boss;
  if (Date.now() < parseTimestamp(boss.respawn_at)) return boss;

  const newGeneration = boss.generation + 1;
  db.prepare(`
    UPDATE world_bosses SET is_alive = 1, current_hp = max_hp, respawn_at = NULL, generation = ? WHERE id = ?
  `).run(newGeneration, boss.id);
  return db.prepare('SELECT * FROM world_bosses WHERE id = ?').get(boss.id);
}

// Top damage-dealers for the boss's CURRENT life (generation) - resets to empty
// each time it respawns, since contributions are scoped per-generation.
function getTopContributors(worldBossId, generation, limit = 10) {
  return db.prepare(`
    SELECT c.name as character_name, wbc.damage_dealt
    FROM world_boss_contributions wbc
    JOIN characters c ON c.id = wbc.character_id
    WHERE wbc.world_boss_id = ? AND wbc.generation = ?
    ORDER BY wbc.damage_dealt DESC
    LIMIT ?
  `).all(worldBossId, generation, limit);
}

function serializeBoss(boss) {
  return {
    id: boss.id,
    name: boss.name,
    level: boss.level,
    maxHp: boss.max_hp,
    currentHp: boss.current_hp,
    isAlive: !!boss.is_alive,
    respawnAt: boss.respawn_at,
    image: boss.image,
    topContributors: getTopContributors(boss.id, boss.generation, 10),
  };
}

// Returns the world boss in a given room, if any (with its respawn lazily processed).
function getBossForRoom(roomId) {
  let boss = db.prepare('SELECT * FROM world_bosses WHERE room_id = ?').get(roomId);
  if (!boss) return null;
  boss = processRespawn(boss);
  return boss;
}

router.get('/room/:roomId', requireAuth, (req, res) => {
  const boss = getBossForRoom(Number(req.params.roomId));
  res.json({ boss: boss ? serializeBoss(boss) : null });
});

router.post('/attack', requireAuth, requireCharacter, (req, res) => {
  const { worldBossId } = req.body;
  let boss = db.prepare('SELECT * FROM world_bosses WHERE id = ?').get(worldBossId);
  if (!boss) {
    return res.status(404).json({ error: 'World boss not found.' });
  }
  if (boss.room_id !== req.character.current_room_id) {
    return res.status(400).json({ error: 'You have to be in the same room as the boss to attack it.' });
  }
  boss = processRespawn(boss);
  if (!boss.is_alive) {
    return res.status(400).json({ error: `${boss.name} is dead. It will return later.` });
  }

  const contribution = db.prepare(`
    SELECT * FROM world_boss_contributions WHERE world_boss_id = ? AND character_id = ? AND generation = ?
  `).get(boss.id, req.character.id, boss.generation);

  if (contribution && contribution.last_attack_at) {
    const elapsed = (Date.now() - parseTimestamp(contribution.last_attack_at)) / 1000;
    if (elapsed < WORLD_BOSS_ATTACK_COOLDOWN_SECONDS) {
      return res.status(429).json({ error: `Wait ${Math.ceil(WORLD_BOSS_ATTACK_COOLDOWN_SECONDS - elapsed)}s before attacking again.` });
    }
  }

  const bonuses = getEquippedBonuses(req.character.id);
  const derived = computeDerivedStats(req.character, bonuses);
  const potionEffects = getActivePotionEffects(req.character.id);
  const weaponRarity = getEquippedWeaponRarity(req.character.id);
  const boostedAttack = Math.round(derived.attack * potionEffects.atkMult);
  const { damage, isCrit } = computeWorldBossDamage(boostedAttack, boss.defense, weaponRarity, potionEffects.critBonus);
  const newHp = Math.max(0, boss.current_hp - damage);
  const now = new Date().toISOString();

  db.prepare('UPDATE world_bosses SET current_hp = ? WHERE id = ?').run(newHp, boss.id);

  if (contribution) {
    db.prepare('UPDATE world_boss_contributions SET damage_dealt = damage_dealt + ?, last_attack_at = ? WHERE id = ?')
      .run(damage, now, contribution.id);
  } else {
    db.prepare(`
      INSERT INTO world_boss_contributions (world_boss_id, character_id, generation, damage_dealt, last_attack_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(boss.id, req.character.id, boss.generation, damage, now);
  }

  let defeatSummary = null;
  if (newHp <= 0) {
    defeatSummary = distributeRewardsAndRespawn(boss);
  }

  const io = getIO();
  if (io) {
    io.to(`room:${boss.room_id}`).emit('world_boss_update', {
      worldBossId: boss.id,
      currentHp: newHp,
      maxHp: boss.max_hp,
      isAlive: newHp > 0,
      lastHitBy: req.character.name,
      lastHitDamage: damage,
      lastHitCrit: isCrit,
      topContributors: getTopContributors(boss.id, boss.generation, 10),
    });
  }

  res.json({
    damage,
    isCrit,
    bossCurrentHp: newHp,
    bossMaxHp: boss.max_hp,
    bossDefeated: newHp <= 0,
    defeatSummary,
    topContributors: getTopContributors(boss.id, boss.generation, 10),
  });
});

// Splits exp/gold proportionally among everyone who contributed damage this generation,
// rolls an independent item-drop chance per contributor, then puts the boss on its respawn timer.
function distributeRewardsAndRespawn(boss) {
  const contributions = db.prepare(`
    SELECT * FROM world_boss_contributions WHERE world_boss_id = ? AND generation = ? ORDER BY damage_dealt DESC
  `).all(boss.id, boss.generation);

  const totalDamage = contributions.reduce((sum, c) => sum + c.damage_dealt, 0) || 1;
  const drops = db.prepare('SELECT * FROM world_boss_drops WHERE world_boss_id = ?').all(boss.id);

  const results = contributions.map(c => {
    const share = c.damage_dealt / totalDamage;
    const potionEffects = getActivePotionEffects(c.character_id);
    const expShare = Math.max(1, Math.round(boss.total_exp_reward * share * potionEffects.expMult));
    const goldShare = Math.max(1, Math.round(boss.total_gold_reward * share * potionEffects.goldMult));

    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(c.character_id);
    if (character) {
      const updatedChar = { ...character };
      applyExpGain(updatedChar, expShare);
      db.prepare('UPDATE characters SET exp = ?, level = ?, attack_points = ?, hp_points = ?, gold = gold + ? WHERE id = ?')
        .run(updatedChar.exp, updatedChar.level, updatedChar.attack_points, updatedChar.hp_points, goldShare, character.id);
    }

    const droppedItems = [];
    drops.forEach(drop => {
      if (Math.random() <= drop.drop_chance) {
        db.prepare('INSERT INTO character_inventory (character_id, item_template_id) VALUES (?, ?)').run(c.character_id, drop.item_template_id);
        const item = db.prepare('SELECT name FROM item_templates WHERE id = ?').get(drop.item_template_id);
        droppedItems.push(item.name);
      }
    });

    return {
      characterId: c.character_id,
      characterName: character ? character.name : 'Unknown',
      damageDealt: c.damage_dealt,
      damageSharePct: Math.round(share * 1000) / 10, // one decimal place
      expShare,
      goldShare,
      droppedItems,
    };
  });

  const respawnAt = new Date(Date.now() + boss.respawn_seconds * 1000).toISOString();
  db.prepare('UPDATE world_bosses SET is_alive = 0, respawn_at = ? WHERE id = ?').run(respawnAt, boss.id);

  // Persisted so "who got what" is answerable after the fact too, not just visible live
  // to whoever's watching when it happens.
  db.prepare(`
    INSERT INTO world_boss_kill_log (world_boss_id, boss_name, generation, total_damage, contributors_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(boss.id, boss.name, boss.generation, totalDamage, JSON.stringify(results));

  const io = getIO();
  if (io) {
    io.to(`room:${boss.room_id}`).emit('world_boss_defeated', { worldBossId: boss.id, name: boss.name, contributors: results });
  }

  return results;
}

// Most recent completed kill for a given boss - lets a player look back at "who got what"
// after the fact, not just live via the socket broadcast at the moment it happens.
router.get('/:bossId/last-kill', requireAuth, requireCharacter, (req, res) => {
  const log = db.prepare(`
    SELECT * FROM world_boss_kill_log WHERE world_boss_id = ? ORDER BY id DESC LIMIT 1
  `).get(req.params.bossId);
  if (!log) {
    return res.json({ log: null });
  }
  res.json({
    log: {
      bossName: log.boss_name,
      generation: log.generation,
      killedAt: log.killed_at,
      totalDamage: log.total_damage,
      contributors: JSON.parse(log.contributors_json),
    },
  });
});

module.exports = { router, getBossForRoom, serializeBoss };
