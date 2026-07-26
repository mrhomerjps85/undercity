const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const {
  computeDerivedStats, resolveCombat, computeTowerMonster, applyTowerExpGain,
  expToNextTowerLevel, TOWER_MAX_LEVEL, TOWER_MILESTONE_INTERVAL,
  TOWER_MILESTONE_BONUS_ATTACK, TOWER_MILESTONE_BONUS_HP,
} = require('../gameLogic');
const { getEquippedBonuses, serializeCharacter, getEquippedWeaponRarity } = require('./character');

const router = express.Router();

const MIN_CHARACTER_LEVEL = 10;

function requireTowerAccess(req, res, next) {
  if (req.character.level < MIN_CHARACTER_LEVEL) {
    return res.status(403).json({ error: `The Tower of Ascension requires character level ${MIN_CHARACTER_LEVEL}.` });
  }
  next();
}

function buildStatusPayload(character) {
  const milestonesReached = Math.floor(character.tower_level / TOWER_MILESTONE_INTERVAL);
  const nextMilestoneAt = character.tower_level >= TOWER_MAX_LEVEL
    ? null
    : (milestonesReached + 1) * TOWER_MILESTONE_INTERVAL;
  const atCap = character.tower_level >= TOWER_MAX_LEVEL;

  return {
    towerLevel: character.tower_level,
    towerExp: character.tower_exp,
    expToNextLevel: atCap ? null : expToNextTowerLevel(character.tower_level + 1),
    atCap,
    milestonesReached,
    nextMilestoneAt,
    permanentBonus: {
      atk: milestonesReached * TOWER_MILESTONE_BONUS_ATTACK,
      hp: milestonesReached * TOWER_MILESTONE_BONUS_HP,
    },
    currentMonster: atCap ? null : computeTowerMonster(character.tower_level + 1),
  };
}

router.get('/status', requireAuth, requireCharacter, requireTowerAccess, (req, res) => {
  res.json(buildStatusPayload(req.character));
});

router.post('/attack', requireAuth, requireCharacter, requireTowerAccess, (req, res) => {
  const character = req.character;
  if (character.tower_level >= TOWER_MAX_LEVEL) {
    return res.status(400).json({ error: "You've already reached the top of the Tower." });
  }

  const bonuses = getEquippedBonuses(character.id);
  const derived = computeDerivedStats(character, bonuses);
  const weaponRarity = getEquippedWeaponRarity(character.id);
  const monster = computeTowerMonster(character.tower_level + 1);

  const result = resolveCombat({ maxHp: derived.maxHp, attack: derived.attack }, monster, weaponRarity);

  let towerLeveledUp = false;
  let milestoneHit = null;
  const previousMilestones = Math.floor(character.tower_level / TOWER_MILESTONE_INTERVAL);

  if (result.victory) {
    const updatedTower = { tower_level: character.tower_level, tower_exp: character.tower_exp };
    const towerResult = applyTowerExpGain(updatedTower, result.expGained);
    towerLeveledUp = towerResult.leveledUp;

    const newMilestones = Math.floor(updatedTower.tower_level / TOWER_MILESTONE_INTERVAL);
    if (newMilestones > previousMilestones) {
      milestoneHit = newMilestones * TOWER_MILESTONE_INTERVAL;
    }

    db.prepare('UPDATE characters SET tower_level = ?, tower_exp = ?, gold = gold + ? WHERE id = ?')
      .run(updatedTower.tower_level, updatedTower.tower_exp, result.goldGained, character.id);
  }

  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(character.id);
  res.json({
    log: result.log,
    victory: result.victory,
    expGained: result.expGained,
    goldGained: result.goldGained,
    crits: result.crits,
    towerLeveledUp,
    milestoneHit,
    character: serializeCharacter(updated),
    status: buildStatusPayload(updated),
  });
});

module.exports = router;
