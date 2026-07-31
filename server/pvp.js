const db = require('./db/db');

const STARTING_RATING = 1500;
const K_FACTOR = 32;
const MAX_ATTACKS_PER_DAY = 15;
const MAX_ATTACKS_PER_TARGET_PER_DAY = 3;

// Standard ELO - the expected win probability comes purely from the rating gap, so an
// "upset" (a big underdog winning) moves both ratings a lot, and an "expected" result
// (the favorite winning) barely moves them at all. This is deliberately why no level
// restriction is needed on matchmaking: the rating system self-corrects for mismatches
// on its own rather than needing to be prevented from happening.
function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function computeEloChange(attackerRating, defenderRating, attackerWon) {
  const expectedAttacker = expectedScore(attackerRating, defenderRating);
  const actualAttacker = attackerWon ? 1 : 0;
  const attackerChange = Math.round(K_FACTOR * (actualAttacker - expectedAttacker));
  // The defender's change is always the exact mirror - a zero-sum system, matching how
  // ELO is meant to work (rating is relative standing, not an absolute score that can
  // inflate or deflate for the population as a whole).
  const defenderChange = -attackerChange;
  return { attackerChange, defenderChange };
}

function countAttacksToday(attackerId) {
  const row = db.prepare(`
    SELECT COUNT(*) c FROM pvp_duels WHERE attacker_id = ? AND date(created_at) = date('now')
  `).get(attackerId);
  return row.c;
}

function countAttacksOnTargetToday(attackerId, defenderId) {
  const row = db.prepare(`
    SELECT COUNT(*) c FROM pvp_duels
    WHERE attacker_id = ? AND defender_id = ? AND date(created_at) = date('now')
  `).get(attackerId, defenderId);
  return row.c;
}

module.exports = {
  STARTING_RATING, K_FACTOR, MAX_ATTACKS_PER_DAY, MAX_ATTACKS_PER_TARGET_PER_DAY,
  expectedScore, computeEloChange, countAttacksToday, countAttacksOnTargetToday,
};
