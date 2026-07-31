const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const { computeDerivedStats, resolvePvpDuel, getCritConfig } = require('../gameLogic');
const { getActivePotionEffects } = require('../potions');
const { getSkillEffects } = require('../skills');
const { getPetEffects } = require('../pets');
const { getClanPerkEffects } = require('../clans');
const { getEquippedBonuses, getEquippedWeaponRarity } = require('./character');
const {
  MAX_ATTACKS_PER_DAY, MAX_ATTACKS_PER_TARGET_PER_DAY,
  computeEloChange, countAttacksToday, countAttacksOnTargetToday,
} = require('../pvp');

const router = express.Router();

// Full fully-boosted combat stats for a character - the same stack of bonuses (gear,
// rebirth, tower, skills, pets, clan, potions) that feeds every other combat path in the
// game, plus a crit chance/multiplier derived from their equipped weapon, since PvP (unlike
// regular combat) lets BOTH sides crit off their own gear.
function getPvpCombatStats(character) {
  const bonuses = getEquippedBonuses(character.id);
  const derived = computeDerivedStats(character, bonuses);
  const potionEffects = getActivePotionEffects(character.id);
  const skillEffects = getSkillEffects(character.id);
  const petEffects = getPetEffects(character.id);
  const clanEffects = getClanPerkEffects(character.clan_id);
  const weaponRarity = getEquippedWeaponRarity(character.id);
  const critConfig = getCritConfig(weaponRarity);

  const attack = Math.round((derived.attack + skillEffects.atkBonus + petEffects.atkBonus) * potionEffects.atkMult * clanEffects.atkMult);
  const maxHp = Math.round((derived.maxHp + skillEffects.hpBonus + petEffects.hpBonus) * potionEffects.hpMult * clanEffects.hpMult);
  const critChance = critConfig.chance + (potionEffects.critBonus + skillEffects.critBonus + petEffects.critBonus) / 100;

  return {
    attack,
    maxHp,
    defense: bonuses.defense || 0,
    critChance,
    critMultiplier: critConfig.multiplier,
  };
}

router.get('/leaderboard', requireAuth, (req, res) => {
  const rankings = db.prepare(`
    SELECT id, name, level, pvp_rating, clan_id FROM characters ORDER BY pvp_rating DESC LIMIT 100
  `).all();
  res.json({ rankings });
});

router.get('/status', requireAuth, requireCharacter, (req, res) => {
  const attacksToday = countAttacksToday(req.character.id);
  res.json({
    rating: req.character.pvp_rating,
    attacksToday,
    attacksRemaining: Math.max(0, MAX_ATTACKS_PER_DAY - attacksToday),
    maxAttacksPerDay: MAX_ATTACKS_PER_DAY,
    maxAttacksPerTargetPerDay: MAX_ATTACKS_PER_TARGET_PER_DAY,
  });
});

router.post('/attack', requireAuth, requireCharacter, (req, res) => {
  const { targetCharacterId } = req.body;
  if (Number(targetCharacterId) === req.character.id) {
    return res.status(400).json({ error: "You can't duel yourself." });
  }
  const defender = db.prepare('SELECT * FROM characters WHERE id = ?').get(targetCharacterId);
  if (!defender) {
    return res.status(404).json({ error: 'Player not found.' });
  }

  const attacksToday = countAttacksToday(req.character.id);
  if (attacksToday >= MAX_ATTACKS_PER_DAY) {
    return res.status(400).json({ error: `You've used all ${MAX_ATTACKS_PER_DAY} of your PvP attacks today.` });
  }
  const attacksOnTarget = countAttacksOnTargetToday(req.character.id, defender.id);
  if (attacksOnTarget >= MAX_ATTACKS_PER_TARGET_PER_DAY) {
    return res.status(400).json({ error: `You've already attacked ${defender.name} ${MAX_ATTACKS_PER_TARGET_PER_DAY} times today.` });
  }

  const attackerStats = getPvpCombatStats(req.character);
  const defenderStats = getPvpCombatStats(defender);
  const result = resolvePvpDuel(attackerStats, defenderStats);

  const attackerRatingBefore = req.character.pvp_rating;
  const defenderRatingBefore = defender.pvp_rating;
  const { attackerChange, defenderChange } = computeEloChange(attackerRatingBefore, defenderRatingBefore, result.attackerWon);
  const attackerRatingAfter = attackerRatingBefore + attackerChange;
  const defenderRatingAfter = defenderRatingBefore + defenderChange;

  db.prepare('UPDATE characters SET pvp_rating = ? WHERE id = ?').run(attackerRatingAfter, req.character.id);
  db.prepare('UPDATE characters SET pvp_rating = ? WHERE id = ?').run(defenderRatingAfter, defender.id);
  db.prepare(`
    INSERT INTO pvp_duels (
      attacker_id, attacker_name, defender_id, defender_name, winner_id,
      attacker_rating_before, defender_rating_before, attacker_rating_after, defender_rating_after,
      rounds_fought
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.character.id, req.character.name, defender.id, defender.name,
    result.attackerWon ? req.character.id : defender.id,
    attackerRatingBefore, defenderRatingBefore, attackerRatingAfter, defenderRatingAfter,
    result.roundsFought
  );

  res.json({
    won: result.attackerWon,
    roundsFought: result.roundsFought,
    defenderName: defender.name,
    ratingBefore: attackerRatingBefore,
    ratingAfter: attackerRatingAfter,
    ratingChange: attackerChange,
    attacksRemaining: Math.max(0, MAX_ATTACKS_PER_DAY - attacksToday - 1),
  });
});

module.exports = router;
