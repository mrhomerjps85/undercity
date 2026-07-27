const db = require('./db/db');

// The permanent counterpart to potions - where a potion is "gold for temporary power,"
// a skill is "gold for permanent power," leveled up one level at a time rather than
// bought instantly-maxed. The catalog lives in code, not a database table, same reasoning
// as the potion catalog - only 5 of them, nothing tradeable/storable about them.
const MAX_SKILL_LEVEL = 25;

// bonusAtLevel(level) returns the TOTAL bonus at that level (not a per-level increment to
// sum) - e.g. Attack Mastery at level 3 grants +100 Attack outright, not 3 separate stacked
// amounts. Attack/Fortitude include a flat "+1 level's worth" base so level 1 already feels
// meaningful (matches the original design: level1 -> +50 ATK, level2 -> +75, level3 -> +100).
const SKILL_DEFINITIONS = {
  attack: {
    name: 'Attack Mastery',
    description: 'Permanent Attack bonus - +50 at level 1, +25 more per level after that.',
    image: 'skill_attack',
    bonusAtLevel: (lvl) => 25 * lvl + 25,
  },
  fortitude: {
    name: 'Fortitude Training',
    description: 'Permanent Max HP bonus - +250 at level 1, +125 more per level after that.',
    image: 'skill_fortitude',
    bonusAtLevel: (lvl) => 125 * lvl + 125,
  },
  precision: {
    name: 'Precision',
    description: 'Permanent critical hit chance bonus - +0.6 percentage points per level.',
    image: 'skill_precision',
    bonusAtLevel: (lvl) => Math.round(0.6 * lvl * 10) / 10,
  },
  wealth: {
    name: 'Wealth',
    description: 'Permanent Gold bonus from kills - +1% per level.',
    image: 'skill_wealth',
    bonusAtLevel: (lvl) => lvl, // percent
  },
  wisdom: {
    name: 'Wisdom',
    description: 'Permanent EXP bonus from kills - +1% per level.',
    image: 'skill_wisdom',
    bonusAtLevel: (lvl) => lvl, // percent
  },
};

// Cost to go from (level) to (level+1) - escalates sharply so early levels are cheap and
// approachable, but maxing a skill out (~27.6M gold cumulative to reach level 25 on just
// one skill) becomes a genuine long-term gold sink.
function costForLevel(level) {
  return 5000 * level * level;
}

function getCharacterSkillLevels(characterId) {
  const rows = db.prepare('SELECT skill_type, level FROM character_skills WHERE character_id = ?').all(characterId);
  const levels = {};
  Object.keys(SKILL_DEFINITIONS).forEach((type) => { levels[type] = 0; });
  rows.forEach((r) => { levels[r.skill_type] = r.level; });
  return levels;
}

function upgradeSkill(characterId, skillType) {
  const def = SKILL_DEFINITIONS[skillType];
  if (!def) throw new Error('Unknown skill type.');
  const existing = db.prepare('SELECT level FROM character_skills WHERE character_id = ? AND skill_type = ?').get(characterId, skillType);
  const currentLevel = existing ? existing.level : 0;
  if (currentLevel >= MAX_SKILL_LEVEL) throw new Error('Already at max level.');

  db.prepare(`
    INSERT INTO character_skills (character_id, skill_type, level) VALUES (?, ?, 1)
    ON CONFLICT(character_id, skill_type) DO UPDATE SET level = level + 1
  `).run(characterId, skillType);

  return currentLevel + 1;
}

// Returns the combined effect of every skill a character has invested in, as bonuses
// ready to apply - callers just add/multiply these into their existing calculation the
// same way potion effects work, just permanent instead of time-limited.
function getSkillEffects(characterId) {
  const levels = getCharacterSkillLevels(characterId);
  return {
    atkBonus: levels.attack > 0 ? SKILL_DEFINITIONS.attack.bonusAtLevel(levels.attack) : 0,
    hpBonus: levels.fortitude > 0 ? SKILL_DEFINITIONS.fortitude.bonusAtLevel(levels.fortitude) : 0,
    critBonus: levels.precision > 0 ? SKILL_DEFINITIONS.precision.bonusAtLevel(levels.precision) : 0,
    goldMult: 1 + (levels.wealth > 0 ? SKILL_DEFINITIONS.wealth.bonusAtLevel(levels.wealth) / 100 : 0),
    expMult: 1 + (levels.wisdom > 0 ? SKILL_DEFINITIONS.wisdom.bonusAtLevel(levels.wisdom) / 100 : 0),
  };
}

module.exports = { SKILL_DEFINITIONS, MAX_SKILL_LEVEL, costForLevel, getCharacterSkillLevels, upgradeSkill, getSkillEffects };
