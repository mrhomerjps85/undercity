const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const { computeDerivedStats, computeWorldBossDamage, WORLD_BOSS_ATTACK_COOLDOWN_SECONDS, applyExpGain } = require('../gameLogic');
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
  const weaponRarity = getEquippedWeaponRarity(req.character.id);
  const { damage, isCrit } = computeWorldBossDamage(derived.attack, boss.defense, weaponRarity);
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
    });
  }

  res.json({
    damage,
    isCrit,
    bossCurrentHp: newHp,
    bossMaxHp: boss.max_hp,
    bossDefeated: newHp <= 0,
    defeatSummary,
  });
});

// Splits exp/gold proportionally among everyone who contributed damage this generation,
// rolls an independent item-drop chance per contributor, then puts the boss on its respawn timer.
function distributeRewardsAndRespawn(boss) {
  const contributions = db.prepare(`
    SELECT * FROM world_boss_contributions WHERE world_boss_id = ? AND generation = ?
  `).all(boss.id, boss.generation);

  const totalDamage = contributions.reduce((sum, c) => sum + c.damage_dealt, 0) || 1;
  const drops = db.prepare('SELECT * FROM world_boss_drops WHERE world_boss_id = ?').all(boss.id);

  const results = contributions.map(c => {
    const share = c.damage_dealt / totalDamage;
    const expShare = Math.max(1, Math.round(boss.total_exp_reward * share));
    const goldShare = Math.max(1, Math.round(boss.total_gold_reward * share));

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

    return { characterId: c.character_id, characterName: character ? character.name : 'Unknown', expShare, goldShare, droppedItems };
  });

  const respawnAt = new Date(Date.now() + boss.respawn_seconds * 1000).toISOString();
  db.prepare('UPDATE world_bosses SET is_alive = 0, respawn_at = ? WHERE id = ?').run(respawnAt, boss.id);

  const io = getIO();
  if (io) {
    io.to(`room:${boss.room_id}`).emit('world_boss_defeated', { worldBossId: boss.id, name: boss.name, contributors: results });
  }

  return results;
}

module.exports = { router, getBossForRoom, serializeBoss };
