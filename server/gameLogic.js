// gameLogic.js - Core formulas for leveling, stats, combat, and respawns.
// Keeping these pure functions in one place makes balancing the game much easier later.

// EXP required to reach the NEXT level from a given level.
function expToNextLevel(level) {
  return Math.floor(100 * Math.pow(level, 1.6));
}

// Recompute derived stats (max_hp, attack) from base stats + level + gear.
// bonuses = { atk, hp } aggregated from equipped items.
// Character only has two allocatable pools: attack_points and hp_points.
// There is no player-side Defense stat - nothing mitigates incoming damage.
// Rebirth grants a small permanent stat bonus per rebirth, stacking additively (not a
// percentage) so it can't spiral out of control after several rebirths.
const REBIRTH_BONUS_ATTACK = 3;
const REBIRTH_BONUS_HP = 15;

// Tower of Ascension: a separate, parallel leveling track (1-100) grinded independently of
// character level. Every 10 tower levels reached grants a permanent stat bonus that survives
// rebirth (rebirth only resets level/exp/attack_points/hp_points, never tower_level/tower_exp).
const TOWER_MILESTONE_INTERVAL = 10;
const TOWER_MILESTONE_BONUS_ATTACK = 1;
const TOWER_MILESTONE_BONUS_HP = 5;
const TOWER_MAX_LEVEL = 100;

function computeDerivedStats(character, bonuses) {
  const rebirths = character.rebirth_count || 0;
  const towerMilestones = Math.floor((character.tower_level || 0) / TOWER_MILESTONE_INTERVAL);
  const maxHp = 50 + character.level * 5 + character.hp_points * 5 + bonuses.hp
    + rebirths * REBIRTH_BONUS_HP + towerMilestones * TOWER_MILESTONE_BONUS_HP;
  const attack = 5 + character.level + character.attack_points * 2 + bonuses.atk
    + rebirths * REBIRTH_BONUS_ATTACK + towerMilestones * TOWER_MILESTONE_BONUS_ATTACK;
  return { maxHp, attack };
}

// Every level-up grants stat points automatically (no manual allocation) using
// a 1:2 Attack:HP split - 1 Attack point and 2 HP points per level, favoring survivability.
const ATTACK_POINTS_PER_LEVEL = 1;
const HP_POINTS_PER_LEVEL = 2;

// Apply a level-up loop: while exp >= threshold, level up and auto-grant stat points.
function applyExpGain(character, expGained) {
  character.exp += expGained;
  let leveledUp = false;
  let levelsGained = 0;
  while (character.exp >= expToNextLevel(character.level)) {
    character.exp -= expToNextLevel(character.level);
    character.level += 1;
    character.attack_points += ATTACK_POINTS_PER_LEVEL;
    character.hp_points += HP_POINTS_PER_LEVEL;
    leveledUp = true;
    levelsGained += 1;
  }
  return { leveledUp, levelsGained };
}

// ---------------------------------------------------------------------
// Tower of Ascension - EXP required for the NEXT tower level, given the current one.
// Deliberately its own curve, separate from expToNextLevel (character leveling) - designed
// so a same-tier tower monster's reward (see computeTowerMonster below) always costs exactly
// 25 kills to clear, for every level from 1 to 100, with no boss cliffs or uneven patches -
// this is meant to be a long, consistent grind, not a story arc with beats.
// ---------------------------------------------------------------------
function expToNextTowerLevel(towerLevel) {
  return Math.round(60 * Math.pow(towerLevel, 1.45));
}

const TOWER_KILLS_PER_LEVEL = 25;
const TOWER_GOLD_RATIO = 0.47; // matches the ratio already established for regular monster rewards

// Named tiers purely for flavor/visual variety - the underlying stats are 100% formula-driven
// from the tower level, not hand-tuned per tier, so there's nothing to keep in sync manually.
const TOWER_TIERS = [
  { maxLevel: 25, name: 'Ascension Sentinel', image: 'ascension_sentinel' },
  { maxLevel: 50, name: 'Ascension Warden', image: 'ascension_warden' },
  { maxLevel: 75, name: 'Ascension Reaper', image: 'ascension_reaper' },
  { maxLevel: 100, name: 'Ascension Titan', image: 'ascension_titan' },
];

function getTowerTier(towerLevel) {
  return TOWER_TIERS.find((t) => towerLevel <= t.maxLevel) || TOWER_TIERS[TOWER_TIERS.length - 1];
}

// Computes the "virtual monster" for a given tower level - not a database row, generated
// live from the formula every time, the same way win-probability estimates are computed
// on the fly rather than stored.
function computeTowerMonster(towerLevel) {
  const tier = getTowerTier(towerLevel);
  const expNeeded = expToNextTowerLevel(towerLevel);
  const expReward = Math.max(5, Math.round(expNeeded / TOWER_KILLS_PER_LEVEL));
  return {
    name: `${tier.name} (Floor ${towerLevel})`,
    image: tier.image,
    level: towerLevel,
    max_hp: 40 + towerLevel * 12,
    attack: 8 + towerLevel * 2,
    defense: 3 + Math.round(towerLevel * 0.8),
    exp_reward: expReward,
    gold_reward: Math.round(expReward * TOWER_GOLD_RATIO),
  };
}

// Tower exp-gain/level-up loop, mirroring applyExpGain's shape but capped at level 100 and
// using the tower's own curve. Character objects here use tower_level/tower_exp, not
// level/exp - kept as a separate function (not a reused applyExpGain) since the two systems
// have different caps and no shared stat-point allocation.
function applyTowerExpGain(character, expGained) {
  character.tower_exp += expGained;
  let leveledUp = false;
  let levelsGained = 0;
  while (character.tower_level < TOWER_MAX_LEVEL && character.tower_exp >= expToNextTowerLevel(character.tower_level + 1)) {
    character.tower_exp -= expToNextTowerLevel(character.tower_level + 1);
    character.tower_level += 1;
    leveledUp = true;
    levelsGained += 1;
  }
  if (character.tower_level >= TOWER_MAX_LEVEL) {
    character.tower_level = TOWER_MAX_LEVEL;
    character.tower_exp = 0; // fully climbed - nothing more to grind toward
  }
  return { leveledUp, levelsGained };
}

// ---------------------------------------------------------------------
// Critical hits - chance and multiplier scale with the rarity of the character's
// equipped weapon, giving hunting/upgrading better gear an extra payoff beyond
// the flat stat bonus. Only the player can crit; monster attacks never do.
// ---------------------------------------------------------------------
const CRIT_BY_RARITY = {
  unarmed: { chance: 0.03, multiplier: 1.4 },
  common: { chance: 0.05, multiplier: 1.5 },
  uncommon: { chance: 0.08, multiplier: 1.6 },
  rare: { chance: 0.12, multiplier: 1.75 },
  epic: { chance: 0.16, multiplier: 1.9 },
  legendary: { chance: 0.22, multiplier: 2.1 },
  mythic: { chance: 0.28, multiplier: 2.35 },
};

function getCritConfig(weaponRarity) {
  return CRIT_BY_RARITY[weaponRarity] || CRIT_BY_RARITY.unarmed;
}

// Resolve a full combat between a character and a monster template.
// Every fight starts at full HP - HP does not carry over between fights.
// weaponRarity ('unarmed'|'common'|...|'legendary') drives the player's crit chance/multiplier.
// Simple deterministic-ish turn-based exchange with light randomness.
// Returns { log: string[], victory: bool, hpRemaining, expGained, goldGained, crits }
function resolveCombat(characterStats, monster, weaponRarity, critBonusPercent = 0) {
  const log = [];
  let playerHp = characterStats.maxHp;
  let monsterHp = monster.max_hp;
  let turn = 0;
  let crits = 0;
  const MAX_TURNS = 100;
  const critConfig = getCritConfig(weaponRarity);
  const effectiveCritChance = critConfig.chance + critBonusPercent / 100;

  while (playerHp > 0 && monsterHp > 0 && turn < MAX_TURNS) {
    turn++;
    // Player attacks
    let playerDmg = Math.max(1, Math.round(characterStats.attack * (0.85 + Math.random() * 0.3) - monster.defense * 0.5));
    const isCrit = Math.random() < effectiveCritChance;
    if (isCrit) {
      playerDmg = Math.round(playerDmg * critConfig.multiplier);
      crits++;
    }
    monsterHp -= playerDmg;
    log.push(isCrit ? `Critical hit! You hit ${monster.name} for ${playerDmg} damage.` : `You hit ${monster.name} for ${playerDmg} damage.`);
    if (monsterHp <= 0) {
      log.push(`You have defeated ${monster.name}!`);
      break;
    }
    // Monster attacks back - the player has no Defense stat, so this isn't mitigated at all.
    const monsterDmg = Math.max(1, Math.round(monster.attack * (0.85 + Math.random() * 0.3)));
    playerHp -= monsterDmg;
    log.push(`${monster.name} hits you for ${monsterDmg} damage.`);
    if (playerHp <= 0) {
      log.push(`You have been defeated by ${monster.name}!`);
      break;
    }
  }

  const victory = monsterHp <= 0 && playerHp > 0;
  return {
    log,
    victory,
    hpRemaining: Math.max(0, playerHp),
    expGained: victory ? monster.exp_reward : 0,
    goldGained: victory ? monster.gold_reward : 0,
    crits,
  };
}

// Runs many simulated fights (silently, no logs) to estimate a win probability
// without spending any real HP/turns - used to show an Easy/Risky/Deadly badge
// before the player commits to a fight. Reuses resolveCombat's exact math so the
// estimate stays consistent with what will actually happen if they attack.
function estimateWinProbability(characterStats, monster, weaponRarity, simulations = 30) {
  let wins = 0;
  for (let i = 0; i < simulations; i++) {
    const result = resolveCombat(characterStats, monster, weaponRarity);
    if (result.victory) wins++;
  }
  const winRate = wins / simulations;
  let difficulty;
  if (winRate >= 0.8) difficulty = 'easy';
  else if (winRate >= 0.4) difficulty = 'risky';
  else difficulty = 'deadly';
  return { winRate, difficulty };
}

// How long (in seconds) a monster of a given level takes to respawn after being defeated.
// Scales gently with level per the design brief ("not so much").
// Regular zones: respawn halved from the original pacing. Dungeons: cut to a third -
// a clearly bigger reduction than regular zones, since dungeon grinding is generally
// more deliberate/farmed than open-zone leveling.
function respawnSeconds(monsterLevel, isDungeon = false) {
  const base = 20 + monsterLevel * 8;
  return Math.round(isDungeon ? base / 3 : base / 2);
}

// ---------------------------------------------------------------------
// Gear upgrading (risk-based enhancement, +0 to +5 per item)
// ---------------------------------------------------------------------
// Levels 1-2 are "safe": a failed attempt just wastes the gold, the item is untouched.
// Levels 3-5 are "risky": a failed attempt has a chance to destroy the item entirely.
const MAX_UPGRADE_LEVEL = 5;
const UPGRADE_SUCCESS_CHANCE = { 1: 0.90, 2: 0.75, 3: 0.60, 4: 0.45, 5: 0.30 };
const UPGRADE_DESTROY_CHANCE_ON_FAIL = { 1: 0, 2: 0, 3: 0.3, 4: 0.4, 5: 0.5 };
const UPGRADE_BONUS_PER_LEVEL = 0.15; // +15% of the item's base bonus_atk/bonus_hp per upgrade level

function upgradeCost(targetLevel) {
  return 50 * targetLevel * targetLevel;
}

// Attempts to take an item from its current upgrade level to current+1.
// Returns { outcome: 'success'|'fail_safe'|'fail_destroyed', newLevel }
function attemptUpgrade(currentLevel) {
  const targetLevel = currentLevel + 1;
  const successChance = UPGRADE_SUCCESS_CHANCE[targetLevel];
  const roll = Math.random();
  if (roll <= successChance) {
    return { outcome: 'success', newLevel: targetLevel };
  }
  const destroyChance = UPGRADE_DESTROY_CHANCE_ON_FAIL[targetLevel];
  if (Math.random() <= destroyChance) {
    return { outcome: 'fail_destroyed', newLevel: currentLevel };
  }
  return { outcome: 'fail_safe', newLevel: currentLevel };
}

// Scales a base stat bonus by an item's upgrade level.
function applyUpgradeMultiplier(baseValue, upgradeLevel) {
  return Math.round(baseValue * (1 + UPGRADE_BONUS_PER_LEVEL * upgradeLevel));
}

// ---------------------------------------------------------------------
// World bosses - shared, server-wide fights. Unlike regular combat, one attack
// call deals a single hit against a persistent shared HP pool rather than
// resolving a full fight to completion. No damage is dealt back to the player -
// this is meant to be a cooperative "everyone chips in" encounter, not a duel.
// ---------------------------------------------------------------------
const WORLD_BOSS_ATTACK_COOLDOWN_SECONDS = 3;

function computeWorldBossDamage(attack, bossDefense, weaponRarity, critBonusPercent = 0) {
  const critConfig = getCritConfig(weaponRarity);
  const effectiveCritChance = critConfig.chance + critBonusPercent / 100;
  let damage = Math.max(1, Math.round(attack * (0.85 + Math.random() * 0.3) - bossDefense * 0.5));
  const isCrit = Math.random() < effectiveCritChance;
  if (isCrit) damage = Math.round(damage * critConfig.multiplier);
  return { damage, isCrit };
}

module.exports = {
  expToNextLevel,
  computeDerivedStats,
  applyExpGain,
  resolveCombat,
  respawnSeconds,
  MAX_UPGRADE_LEVEL,
  UPGRADE_SUCCESS_CHANCE,
  UPGRADE_DESTROY_CHANCE_ON_FAIL,
  upgradeCost,
  attemptUpgrade,
  applyUpgradeMultiplier,
  WORLD_BOSS_ATTACK_COOLDOWN_SECONDS,
  computeWorldBossDamage,
  getCritConfig,
  estimateWinProbability,
  REBIRTH_BONUS_ATTACK,
  REBIRTH_BONUS_HP,
  expToNextTowerLevel,
  computeTowerMonster,
  applyTowerExpGain,
  TOWER_MAX_LEVEL,
  TOWER_MILESTONE_INTERVAL,
  TOWER_MILESTONE_BONUS_ATTACK,
  TOWER_MILESTONE_BONUS_HP,
};
