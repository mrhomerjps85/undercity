const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const {
  computeDerivedStats, expToNextLevel, applyUpgradeMultiplier, getCritConfig,
  REBIRTH_BONUS_ATTACK, REBIRTH_BONUS_HP,
  TOWER_MILESTONE_INTERVAL, TOWER_MILESTONE_BONUS_ATTACK, TOWER_MILESTONE_BONUS_HP,
} = require('../gameLogic');
const { getActivePotionEffects, getActiveBuffsList } = require('../potions');
const { getClanPerkEffects } = require('../clans');
const { getPetEffects } = require('../pets');
const { getSkillEffects, getCharacterSkillLevels, SKILL_DEFINITIONS } = require('../skills');

const router = express.Router();

// Aggregates equipped items' Attack/HP bonuses (scaled by each item's individual
// upgrade level) plus any set bonuses unlocked by equipping enough pieces of a set.
function getEquippedBonuses(characterId) {
  const items = db.prepare(`
    SELECT ci.upgrade_level, it.* FROM character_inventory ci
    JOIN item_templates it ON it.id = ci.item_template_id
    WHERE ci.character_id = ? AND ci.equipped = 1
  `).all(characterId);

  const totals = items.reduce((acc, it) => {
    acc.atk += applyUpgradeMultiplier(it.bonus_atk, it.upgrade_level);
    acc.hp += applyUpgradeMultiplier(it.bonus_hp, it.upgrade_level);
    return acc;
  }, { atk: 0, hp: 0 });

  // Count equipped pieces per set, then add the highest set bonus tier each set qualifies for.
  const setCounts = {};
  items.forEach(it => {
    if (it.set_id) setCounts[it.set_id] = (setCounts[it.set_id] || 0) + 1;
  });
  for (const [setId, count] of Object.entries(setCounts)) {
    const tiers = db.prepare('SELECT * FROM set_bonuses WHERE set_id = ? AND pieces_required <= ? ORDER BY pieces_required DESC LIMIT 1').get(setId, count);
    if (tiers) {
      totals.atk += tiers.bonus_atk;
      totals.hp += tiers.bonus_hp;
    }
  }

  return totals;
}

// Returns active set info for display: which sets are partially/fully equipped,
// how many pieces out of the set's total, and the bonus text for pieces owned/equipped.
function getActiveSetInfo(characterId) {
  const equippedItems = db.prepare(`
    SELECT it.set_id, it.id as item_id FROM character_inventory ci
    JOIN item_templates it ON it.id = ci.item_template_id
    WHERE ci.character_id = ? AND ci.equipped = 1 AND it.set_id IS NOT NULL
  `).all(characterId);

  const setIds = [...new Set(equippedItems.map(i => i.set_id))];
  return setIds.map(setId => {
    const set = db.prepare('SELECT * FROM item_sets WHERE id = ?').get(setId);
    // Counts distinct SLOTS the set actually occupies, not raw item_template rows - a
    // rebirth-generational "(Gen N)" item shares its base item's set_id and slot, so
    // counting rows directly over-counts every time a new generation gets created
    // (server-wide, by any player), even though the set still only has as many real
    // "positions" as it has distinct slots.
    const totalPieces = db.prepare('SELECT COUNT(DISTINCT slot) c FROM item_templates WHERE set_id = ?').get(setId).c;
    const equippedCount = equippedItems.filter(i => i.set_id === setId).length;
    const bonusTiers = db.prepare('SELECT * FROM set_bonuses WHERE set_id = ? ORDER BY pieces_required ASC').all(setId);
    return { ...set, equippedCount, totalPieces, bonusTiers };
  });
}

// Returns the rarity of the character's currently equipped weapon ('unarmed' if none) -
// drives crit chance/multiplier in combat (see gameLogic.getCritConfig).
function getEquippedWeaponRarity(characterId) {
  const weapon = db.prepare(`
    SELECT it.rarity FROM character_inventory ci
    JOIN item_templates it ON it.id = ci.item_template_id
    WHERE ci.character_id = ? AND ci.equipped = 1 AND it.slot = 'weapon'
    LIMIT 1
  `).get(characterId);
  return weapon ? weapon.rarity : 'unarmed';
}

function serializeCharacter(character) {
  const bonuses = getEquippedBonuses(character.id);
  const derived = computeDerivedStats(character, bonuses);
  const potionEffects = getActivePotionEffects(character.id);
  const skillEffects = getSkillEffects(character.id);
  const clanEffects = getClanPerkEffects(character.clan_id);
  const petEffects = getPetEffects(character.id);
  // Potion attack/HP bonuses are percentage multipliers applied on top of the fully
  // computed stat (gear + rebirth + tower + skills all included), not folded into
  // computeDerivedStats itself - keeps that function a pure, DB-free calculation and
  // applies the temporary boost as a final step, the same way it's applied at combat time.
  const boostedAttack = Math.round((derived.attack + skillEffects.atkBonus + petEffects.atkBonus) * potionEffects.atkMult * clanEffects.atkMult);
  const boostedMaxHp = Math.round((derived.maxHp + skillEffects.hpBonus + petEffects.hpBonus) * potionEffects.hpMult * clanEffects.hpMult);
  const towerMilestones = Math.floor((character.tower_level || 0) / TOWER_MILESTONE_INTERVAL);
  return {
    ...character,
    max_hp: boostedMaxHp,
    attack: boostedAttack,
    exp_to_next_level: expToNextLevel(character.level),
    active_buffs: getActiveBuffsList(character.id),
    // Broken out separately so the Character sheet can show players exactly where their
    // permanent bonuses are coming from, rather than a single opaque total.
    rebirth_bonus: {
      atk: (character.rebirth_count || 0) * REBIRTH_BONUS_ATTACK,
      hp: (character.rebirth_count || 0) * REBIRTH_BONUS_HP,
    },
    tower_bonus: {
      atk: towerMilestones * TOWER_MILESTONE_BONUS_ATTACK,
      hp: towerMilestones * TOWER_MILESTONE_BONUS_HP,
      milestonesReached: towerMilestones,
    },
  };
}

router.post('/', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT id FROM characters WHERE user_id = ?').get(req.session.userId);
  if (existing) {
    return res.status(409).json({ error: 'You already have a character.' });
  }

  const { name } = req.body;
  if (!name || name.length < 2 || name.length > 20) {
    return res.status(400).json({ error: 'Character name must be 2-20 characters.' });
  }

  const nameTaken = db.prepare('SELECT id FROM characters WHERE name = ?').get(name);
  if (nameTaken) {
    return res.status(409).json({ error: 'That character name is already taken.' });
  }

  // Spawn point: the designated entrance room of the lowest-level non-dungeon zone.
  const spawnRoom = db.prepare(`
    SELECT r.id FROM rooms r
    JOIN zones z ON z.id = r.zone_id
    WHERE r.is_entrance = 1 AND z.is_dungeon = 0
    ORDER BY z.min_level ASC LIMIT 1
  `).get() || db.prepare('SELECT id FROM rooms ORDER BY id ASC LIMIT 1').get();

  const result = db.prepare(`
    INSERT INTO characters (user_id, name, current_room_id)
    VALUES (?, ?, ?)
  `).run(req.session.userId, name, spawnRoom.id);

  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(result.lastInsertRowid);
  res.json({ character: serializeCharacter(character) });
});

router.get('/me', requireAuth, requireCharacter, (req, res) => {
  res.json({ character: serializeCharacter(req.character) });
});

// Begins the tutorial: grants a starter weapon (so there's something to equip in the
// last step) and advances to step 1 ("move to a room with a monster").
router.post('/tutorial/start', requireAuth, requireCharacter, (req, res) => {
  if (req.character.tutorial_step !== 0) {
    return res.status(400).json({ error: 'Tutorial already started.' });
  }
  const starterWeapon = db.prepare("SELECT id FROM item_templates WHERE name = 'Rusty Switchblade'").get();
  if (starterWeapon) {
    db.prepare('INSERT INTO character_inventory (character_id, item_template_id) VALUES (?, ?)').run(req.character.id, starterWeapon.id);
  }
  db.prepare('UPDATE characters SET tutorial_step = 1 WHERE id = ?').run(req.character.id);
  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({ character: serializeCharacter(updated) });
});

// Skips the tutorial entirely - jumps straight to "done," no completion reward.
router.post('/tutorial/skip', requireAuth, requireCharacter, (req, res) => {
  if (req.character.tutorial_step >= 5) {
    return res.status(400).json({ error: 'Tutorial already finished.' });
  }
  db.prepare('UPDATE characters SET tutorial_step = 5 WHERE id = ?').run(req.character.id);
  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({ character: serializeCharacter(updated) });
});

// Public profile lookup by character name - what any logged-in player sees when they
// click another player's name in chat, room presence, or the leaderboard. Deliberately
// excludes gold and unequipped inventory (that's "wallet contents," not a profile) -
// only equipped gear, derived stats, active sets, and clan are shown.
router.get('/profile/:name', requireAuth, (req, res) => {
  const character = db.prepare('SELECT * FROM characters WHERE name = ?').get(req.params.name);
  if (!character) {
    return res.status(404).json({ error: 'Character not found.' });
  }

  const bonuses = getEquippedBonuses(character.id);
  const derived = computeDerivedStats(character, bonuses);

  const equippedItems = db.prepare(`
    SELECT ci.upgrade_level, it.slot, it.name, it.image, it.rarity, it.bonus_atk, it.bonus_hp,
           it.required_level, iset.name as set_name
    FROM character_inventory ci
    JOIN item_templates it ON it.id = ci.item_template_id
    LEFT JOIN item_sets iset ON iset.id = it.set_id
    WHERE ci.character_id = ? AND ci.equipped = 1
  `).all(character.id);

  let clanName = null;
  if (character.clan_id) {
    const clan = db.prepare('SELECT name FROM clans WHERE id = ?').get(character.clan_id);
    clanName = clan ? clan.name : null;
  }

  res.json({
    profile: {
      name: character.name,
      level: character.level,
      attack: derived.attack,
      maxHp: derived.maxHp,
      clanName,
      equippedItems,
      activeSets: getActiveSetInfo(character.id),
    },
  });
});

// Rebirth (prestige): available at level 50. Resets level/exp/allocated stat points back
// to a fresh start, but keeps gold and inventory - a full wipe would just be punishing, and
// keeping gear is the whole appeal of steamrolling early levels on the way back up. Grants
// a small permanent stat bonus (baked into computeDerivedStats via rebirth_count) that
// stacks with every future rebirth, and moves the character back to Main St.'s entrance.
router.post('/rebirth', requireAuth, requireCharacter, (req, res) => {
  if (req.character.level < 50) {
    return res.status(400).json({ error: 'Rebirth requires level 50.' });
  }

  const mainStEntrance = db.prepare(`
    SELECT r.id FROM rooms r JOIN zones z ON z.id = r.zone_id
    WHERE z.name = 'Main St.' AND r.is_entrance = 1 LIMIT 1
  `).get();

  // Compute what max HP will actually be post-rebirth (level 1, no allocated points, but
  // still accounting for equipped gear + the new rebirth bonus) so current_hp starts full
  // and accurate, rather than a guessed flat number that could be wrong either direction.
  const bonuses = getEquippedBonuses(req.character.id);
  const postRebirthStats = computeDerivedStats(
    { level: 1, attack_points: 0, hp_points: 0, rebirth_count: req.character.rebirth_count + 1 },
    bonuses
  );

  db.prepare(`
    UPDATE characters
    SET level = 1, exp = 0, attack_points = 0, hp_points = 0, current_hp = ?,
        rebirth_count = rebirth_count + 1, current_room_id = ?
    WHERE id = ?
  `).run(postRebirthStats.maxHp, mainStEntrance ? mainStEntrance.id : req.character.current_room_id, req.character.id);

  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({ character: serializeCharacter(updated) });
});

// A detailed, itemized breakdown of exactly where every point of Attack/Max HP comes
// from - built by calling the REAL computeDerivedStats formula with progressively more
// inputs enabled and diffing each step, rather than re-deriving the formula by hand here.
// This guarantees the breakdown can never drift out of sync with the actual calculation
// used everywhere else, even if that formula changes later.
router.get('/stat-breakdown', requireAuth, requireCharacter, (req, res) => {
  const character = req.character;

  const equippedItems = db.prepare(`
    SELECT ci.upgrade_level, it.* FROM character_inventory ci
    JOIN item_templates it ON it.id = ci.item_template_id
    WHERE ci.character_id = ? AND ci.equipped = 1
  `).all(character.id);

  const itemsOnly = equippedItems.reduce((acc, it) => {
    acc.atk += applyUpgradeMultiplier(it.bonus_atk, it.upgrade_level);
    acc.hp += applyUpgradeMultiplier(it.bonus_hp, it.upgrade_level);
    return acc;
  }, { atk: 0, hp: 0 });

  const setCounts = {};
  equippedItems.forEach((it) => { if (it.set_id) setCounts[it.set_id] = (setCounts[it.set_id] || 0) + 1; });
  const setBonus = { atk: 0, hp: 0 };
  const activeSets = [];
  for (const [setId, count] of Object.entries(setCounts)) {
    const tier = db.prepare('SELECT * FROM set_bonuses WHERE set_id = ? AND pieces_required <= ? ORDER BY pieces_required DESC LIMIT 1').get(setId, count);
    if (tier) {
      setBonus.atk += tier.bonus_atk;
      setBonus.hp += tier.bonus_hp;
      const setInfo = db.prepare('SELECT name FROM item_sets WHERE id = ?').get(setId);
      activeSets.push({ name: setInfo.name, pieces: count, atk: tier.bonus_atk, hp: tier.bonus_hp });
    }
  }

  const zero = { atk: 0, hp: 0 };
  const withItems = { atk: itemsOnly.atk, hp: itemsOnly.hp };
  const withItemsAndSet = { atk: itemsOnly.atk + setBonus.atk, hp: itemsOnly.hp + setBonus.hp };

  const stageLevelOnly = computeDerivedStats({ level: character.level, attack_points: 0, hp_points: 0, rebirth_count: 0, tower_level: 0 }, zero);
  const stagePoints = computeDerivedStats({ level: character.level, attack_points: character.attack_points, hp_points: character.hp_points, rebirth_count: 0, tower_level: 0 }, zero);
  const stageItems = computeDerivedStats({ level: character.level, attack_points: character.attack_points, hp_points: character.hp_points, rebirth_count: 0, tower_level: 0 }, withItems);
  const stageSet = computeDerivedStats({ level: character.level, attack_points: character.attack_points, hp_points: character.hp_points, rebirth_count: 0, tower_level: 0 }, withItemsAndSet);
  const stageRebirth = computeDerivedStats({ level: character.level, attack_points: character.attack_points, hp_points: character.hp_points, rebirth_count: character.rebirth_count, tower_level: 0 }, withItemsAndSet);
  const stageTower = computeDerivedStats({ level: character.level, attack_points: character.attack_points, hp_points: character.hp_points, rebirth_count: character.rebirth_count, tower_level: character.tower_level }, withItemsAndSet);

  const potionEffects = getActivePotionEffects(character.id);
  const skillEffects = getSkillEffects(character.id);
  const skillLevels = getCharacterSkillLevels(character.id);
  const clanEffects = getClanPerkEffects(character.clan_id);
  const petEffects = getPetEffects(character.id);
  const activePet = character.active_pet_template_id
    ? db.prepare('SELECT * FROM pet_templates WHERE id = ?').get(character.active_pet_template_id)
    : null;
  const stageSkills = { attack: stageTower.attack + skillEffects.atkBonus, maxHp: stageTower.maxHp + skillEffects.hpBonus };
  const stagePet = { attack: stageSkills.attack + petEffects.atkBonus, maxHp: stageSkills.maxHp + petEffects.hpBonus };
  const stageClan = { attack: Math.round(stagePet.attack * clanEffects.atkMult), maxHp: Math.round(stagePet.maxHp * clanEffects.hpMult) };
  const finalAttack = Math.round(stageClan.attack * potionEffects.atkMult);
  const finalMaxHp = Math.round(stageClan.maxHp * potionEffects.hpMult);

  const weaponRarity = getEquippedWeaponRarity(character.id);
  const critConfig = getCritConfig(weaponRarity);
  const baseCritChancePct = Math.round(critConfig.chance * 1000) / 10;
  const potionCritBonusPct = potionEffects.critBonus;
  const skillCritBonusPct = skillEffects.critBonus;
  const petCritBonusPct = petEffects.critBonus;

  res.json({
    level: character.level,
    base: { atk: stageLevelOnly.attack, hp: stageLevelOnly.maxHp },
    allocatedPoints: {
      attackPoints: character.attack_points,
      hpPoints: character.hp_points,
      atk: stagePoints.attack - stageLevelOnly.attack,
      hp: stagePoints.maxHp - stageLevelOnly.maxHp,
    },
    equipment: {
      items: itemsOnly,
      setBonus,
      activeSets,
      atk: stageSet.attack - stagePoints.attack,
      hp: stageSet.maxHp - stagePoints.maxHp,
    },
    rebirth: {
      count: character.rebirth_count || 0,
      atk: stageRebirth.attack - stageSet.attack,
      hp: stageRebirth.maxHp - stageSet.maxHp,
    },
    tower: {
      floor: character.tower_level || 0,
      milestonesReached: Math.floor((character.tower_level || 0) / TOWER_MILESTONE_INTERVAL),
      atk: stageTower.attack - stageRebirth.attack,
      hp: stageTower.maxHp - stageRebirth.maxHp,
    },
    skills: {
      levels: skillLevels,
      atk: stageSkills.attack - stageTower.attack,
      hp: stageSkills.maxHp - stageTower.maxHp,
      goldMult: skillEffects.goldMult,
      expMult: skillEffects.expMult,
    },
    pet: {
      active: activePet ? { name: activePet.name, rarity: activePet.rarity, bonusType: activePet.bonus_type, bonusValue: activePet.bonus_value, image: activePet.image } : null,
      atk: stagePet.attack - stageSkills.attack,
      hp: stagePet.maxHp - stageSkills.maxHp,
      goldMult: petEffects.goldMult,
      expMult: petEffects.expMult,
    },
    clan: {
      inClan: !!character.clan_id,
      perkPercent: character.clan_id ? Math.round((clanEffects.atkMult - 1) * 1000) / 10 : 0,
      atk: stageClan.attack - stagePet.attack,
      hp: stageClan.maxHp - stagePet.maxHp,
    },
    potions: {
      atkMult: potionEffects.atkMult,
      hpMult: potionEffects.hpMult,
      atk: finalAttack - stageClan.attack,
      hp: finalMaxHp - stageClan.maxHp,
    },
    final: { atk: finalAttack, hp: finalMaxHp },
    crit: {
      weaponRarity,
      baseChancePct: baseCritChancePct,
      multiplier: critConfig.multiplier,
      skillBonusPct: skillCritBonusPct,
      petBonusPct: petCritBonusPct,
      potionBonusPct: potionCritBonusPct,
      effectiveChancePct: Math.round((baseCritChancePct + skillCritBonusPct + petCritBonusPct + potionCritBonusPct) * 10) / 10,
    },
  });
});

module.exports = { router, serializeCharacter, getEquippedBonuses, getActiveSetInfo, getEquippedWeaponRarity };
