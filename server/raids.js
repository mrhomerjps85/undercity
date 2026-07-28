const db = require('./db/db');

// The single Raid Boss for this first pass - a genuinely imposing threat (well above even
// The Unbound's 220k HP) since with no cooldown between raids, difficulty itself is what
// keeps this from being trivially farmable, not an artificial timer.
const RAID_BOSS = {
  name: 'The Rift Sovereign',
  image: 'rift_sovereign',
  level: 55,
  maxHp: 1200000,
  attack: 150,
  defense: 60,
  totalExpReward: 60000,
  totalGoldReward: 40000,
};

const GATHERING_WINDOW_MINUTES = 60;
const MIN_PARTICIPANTS_TO_ACTIVATE = 3;

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
  RAID_BOSS, GATHERING_WINDOW_MINUTES, MIN_PARTICIPANTS_TO_ACTIVATE,
  getRaidRewardItemIds, expireStaleGatheringRaids,
};
