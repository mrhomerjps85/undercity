const db = require('./db/db');

// The potion catalog lives in code, not a database table - there are only 5 of them and
// they're instant-use (bought = immediately activated), not tradeable or storable, so a
// full item_templates-style catalog would be more structure than this needs.
const POTION_DURATION_SECONDS = 300; // 5 minutes, uniform across every potion type

const POTION_DEFINITIONS = {
  fortitude: { name: 'Fortitude Draught', description: '+25% Max HP for 5 minutes.', price: 25000, image: 'potion_fortitude', magnitude: 0.25 },
  crit: { name: 'Crit Elixir', description: '+15 percentage points critical hit chance for 5 minutes.', price: 28000, image: 'potion_crit', magnitude: 15 },
  attack: { name: 'Battle Tonic', description: '+20% Attack for 5 minutes.', price: 30000, image: 'potion_attack', magnitude: 0.20 },
  gold: { name: 'Prosperity Potion', description: '+40% Gold from kills for 5 minutes.', price: 35000, image: 'potion_gold', magnitude: 0.40 },
  exp: { name: 'EXP Elixir', description: '+50% EXP from kills for 5 minutes.', price: 50000, image: 'potion_exp', magnitude: 0.50 },
};

// Buying while one of the same type is already active refreshes the timer to a fresh 5
// minutes rather than stacking duration - simplest, most predictable behavior. Different
// potion types stack with each other freely (separate rows, separate effects).
function buyPotion(characterId, potionType) {
  const def = POTION_DEFINITIONS[potionType];
  if (!def) throw new Error('Unknown potion type.');
  const expiresAt = new Date(Date.now() + POTION_DURATION_SECONDS * 1000).toISOString();
  db.prepare(`
    INSERT INTO character_active_buffs (character_id, potion_type, magnitude, expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(character_id, potion_type) DO UPDATE SET magnitude = excluded.magnitude, expires_at = excluded.expires_at
  `).run(characterId, potionType, def.magnitude, expiresAt);
}

// Returns the combined effect of every currently-active buff, as multipliers/bonuses ready
// to apply - callers just multiply/add these into their existing calculation rather than
// needing to know anything about potions themselves. Neutral values (1 / 0) when nothing
// is active, so this is always safe to apply unconditionally.
function getActivePotionEffects(characterId) {
  const now = new Date().toISOString();
  const rows = db.prepare('SELECT potion_type, magnitude FROM character_active_buffs WHERE character_id = ? AND expires_at > ?')
    .all(characterId, now);

  const effects = { atkMult: 1, hpMult: 1, critBonus: 0, expMult: 1, goldMult: 1 };
  for (const row of rows) {
    if (row.potion_type === 'attack') effects.atkMult = 1 + row.magnitude;
    if (row.potion_type === 'fortitude') effects.hpMult = 1 + row.magnitude;
    if (row.potion_type === 'crit') effects.critBonus = row.magnitude;
    if (row.potion_type === 'exp') effects.expMult = 1 + row.magnitude;
    if (row.potion_type === 'gold') effects.goldMult = 1 + row.magnitude;
  }
  return effects;
}

// A display-friendly list of active buffs (with time remaining) - for the character
// sheet and the top bar, so a player can actually see what's running and for how long.
function getActiveBuffsList(characterId) {
  const now = Date.now();
  const rows = db.prepare('SELECT potion_type, magnitude, expires_at FROM character_active_buffs WHERE character_id = ? AND expires_at > ?')
    .all(characterId, new Date(now).toISOString());

  return rows.map((r) => ({
    potionType: r.potion_type,
    name: POTION_DEFINITIONS[r.potion_type].name,
    magnitude: r.magnitude,
    secondsRemaining: Math.max(0, Math.round((new Date(r.expires_at).getTime() - now) / 1000)),
  }));
}

module.exports = { POTION_DEFINITIONS, POTION_DURATION_SECONDS, buyPotion, getActivePotionEffects, getActiveBuffsList };
