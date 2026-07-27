const db = require('./db/db');

// EXP required for a clan to reach the NEXT level, given its current one. Deliberately
// steep - but since MANY members contribute simultaneously (see applyClanXpGain), an
// active clan levels up much faster than any single character would on this same curve.
function expToNextClanLevel(level) {
  return Math.round(2000 * Math.pow(level, 1.6));
}

// Base 10 member slots, +2 every 2 clan levels - gives smaller/newer clans room to
// operate immediately while rewarding sustained growth with real capacity to expand.
function memberCapForLevel(level) {
  return 10 + Math.floor(level / 2) * 2;
}

// Every clan level grants a small permanent %ATK/%HP/%Gold bonus to EVERY member - kept
// modest (0.5% per level) since it's shared across a whole roster's combined effort,
// not gated behind one player's individual investment the way Skills are.
function clanPerkPercent(level) {
  return Math.round(level * 0.5 * 10) / 10;
}

function getClan(clanId) {
  return db.prepare('SELECT * FROM clans WHERE id = ?').get(clanId);
}

// A slice of every EXP gain a member earns also feeds the clan's XP pool - applied
// alongside Potions/Skills at the same combat integration points, not a replacement for
// personal EXP (the character still gets their own gain in full; this is additive).
const CLAN_XP_CONTRIBUTION_RATE = 0.1;

function contributeClanXp(clanId, expGained) {
  if (!clanId) return;
  const clan = getClan(clanId);
  if (!clan) return;

  const contribution = Math.round(expGained * CLAN_XP_CONTRIBUTION_RATE);
  let newXp = clan.clan_xp + contribution;
  let newLevel = clan.clan_level;
  while (newXp >= expToNextClanLevel(newLevel)) {
    newXp -= expToNextClanLevel(newLevel);
    newLevel += 1;
  }
  db.prepare('UPDATE clans SET clan_xp = ?, clan_level = ? WHERE id = ?').run(newXp, newLevel, clanId);
}

// Returns the %ATK/%HP/%Gold multiplier bonus from clan level for a character - neutral
// (1.0) if not in a clan, so always safe to apply unconditionally.
function getClanPerkEffects(clanId) {
  if (!clanId) return { atkMult: 1, hpMult: 1, goldMult: 1 };
  const clan = getClan(clanId);
  if (!clan) return { atkMult: 1, hpMult: 1, goldMult: 1 };
  const pct = clanPerkPercent(clan.clan_level) / 100;
  return { atkMult: 1 + pct, hpMult: 1 + pct, goldMult: 1 + pct };
}

function canManageClan(character) {
  return character.clan_role === 'leader' || character.clan_role === 'officer';
}

module.exports = {
  expToNextClanLevel, memberCapForLevel, clanPerkPercent,
  getClan, contributeClanXp, getClanPerkEffects, canManageClan,
  CLAN_XP_CONTRIBUTION_RATE,
};
