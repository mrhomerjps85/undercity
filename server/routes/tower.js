const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const {
  computeDerivedStats, resolveCombat, computeTowerMonster, applyTowerExpGain,
  expToNextTowerLevel, TOWER_MAX_LEVEL, TOWER_MILESTONE_INTERVAL,
  TOWER_MILESTONE_BONUS_ATTACK, TOWER_MILESTONE_BONUS_HP,
} = require('../gameLogic');
const { getActivePotionEffects } = require('../potions');
const { getSkillEffects } = require('../skills');
const { getClanPerkEffects, contributeClanXp } = require('../clans');
const { getPetEffects, rollPetDrop } = require('../pets');
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
  const potionEffects = getActivePotionEffects(character.id);
  const skillEffects = getSkillEffects(character.id);
  const clanEffects = getClanPerkEffects(character.clan_id);
  const petEffects = getPetEffects(character.id);
  const weaponRarity = getEquippedWeaponRarity(character.id);
  const monster = computeTowerMonster(character.tower_level + 1);

  const result = resolveCombat(
    {
      maxHp: Math.round((derived.maxHp + skillEffects.hpBonus + petEffects.hpBonus) * potionEffects.hpMult * clanEffects.hpMult),
      attack: Math.round((derived.attack + skillEffects.atkBonus + petEffects.atkBonus) * potionEffects.atkMult * clanEffects.atkMult),
    },
    monster, weaponRarity, potionEffects.critBonus + skillEffects.critBonus + petEffects.critBonus
  );
  result.expGained = Math.round(result.expGained * skillEffects.expMult * potionEffects.expMult * petEffects.expMult);
  result.goldGained = Math.round(result.goldGained * skillEffects.goldMult * potionEffects.goldMult * clanEffects.goldMult * petEffects.goldMult);
  if (result.victory) {
    contributeClanXp(character.clan_id, result.expGained);
  }

  let towerLeveledUp = false;
  let milestoneHit = null;
  let droppedPet = null;
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
    droppedPet = rollPetDrop(character.id);
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
    droppedPet,
    character: serializeCharacter(updated),
    status: buildStatusPayload(updated),
  });
});

// A separate ranking from the main character leaderboard - climbing the Tower is its own
// axis of progress, independent of character level/rebirth, so it gets its own board here
// on the Ascension tab rather than being folded into the main Rankings page.
router.get('/leaderboard', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT name, tower_level, tower_exp FROM characters
    WHERE tower_level > 0
    ORDER BY tower_level DESC, tower_exp DESC
    LIMIT 50
  `).all();
  res.json({ rankings: rows });
});

module.exports = router;
