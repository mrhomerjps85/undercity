const db = require('./db/db');

// Retuned for turn-based round combat - the old values (1.2M HP, unused attack stat) were
// designed for "anyone clicks attack whenever, independently, unlimited times" pacing.
// Rounds require everyone to ready up first, so the realistic number of rounds in a
// sitting is much lower than the old unlimited-click model - HP is scaled down to make a
// full fight roughly 10-30 rounds for a reasonably-geared group. attack was previously
// defined but never actually used against players (world bosses never damage back) -
// this is the first time it does real work, so these numbers are a first-pass estimate
// that will likely need retuning after actual play, not something verifiable by testing
// alone.
const RAID_BOSS = {
  name: 'The Rift Sovereign',
  image: 'rift_sovereign',
  level: 55,
  maxHp: 30000,
  attack: 150, // per-participant multiplier - see computeBossDamageToParty
  defense: 60,
  totalExpReward: 60000,
  totalGoldReward: 40000,
};

// The boss's damage to the party each round, scaled by participant count so a bigger raid
// group doesn't automatically trivialize the fight just by having more combined HP - the
// boss hits proportionally harder too, keeping difficulty roughly consistent regardless of
// raid size (3 vs 10).
function computeBossDamageToParty(participantCount) {
  return Math.round(RAID_BOSS.attack * participantCount * (0.85 + Math.random() * 0.3));
}

const GATHERING_WINDOW_MINUTES = 60;
// A real, enforced minimum again - the Leader/Officer can launch whenever they want,
// but only once at least this many members have joined.
const MIN_PARTICIPANTS_TO_LAUNCH = 3;

// The exclusive Sovereign's Dominion set - resolved by name at runtime rather than storing
// IDs here directly, since seed.js is what actually creates these rows and ID values
// shouldn't be assumed/hardcoded outside of it.
const RAID_ITEM_NAMES = [
  "Sovereign's Blade", "Sovereign's Plate", "Sovereign's Crown",
  "Sovereign's Grasp", "Sovereign's Greaves", "Sovereign's Stride",
];

function getRaidRewardItemIds() {
  return RAID_ITEM_NAMES
    .map((name) => db.prepare('SELECT id FROM item_templates WHERE name = ?').get(name))
    .filter(Boolean)
    .map((row) => row.id);
}

// Lazily expires a raid that's been stuck in 'gathering' past its window without reaching
// the minimum participant count - same "check on read" pattern as Marketplace listings and
// world boss respawns, rather than a background job.
function expireStaleGatheringRaids() {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE raids SET status = 'expired'
    WHERE status = 'gathering' AND gathering_expires_at < ?
  `).run(now);
}

module.exports = {
  RAID_BOSS, GATHERING_WINDOW_MINUTES, MIN_PARTICIPANTS_TO_LAUNCH,
  getRaidRewardItemIds, expireStaleGatheringRaids, computeBossDamageToParty,
};
