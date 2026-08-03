const db = require('./db/db');

// A catalog of raid bosses, keyed by a stable slug used as raids.boss_key - a clan still
// runs one raid at a time, but the creator chooses which boss to fight. Stats retuned for
// turn-based round combat (see comments on the original Rift Sovereign build) - HP scaled
// so a full fight runs roughly 10-30 rounds for a reasonably-geared group, and attack
// actually deals damage back to the party now, unlike the old world-boss-style model
// where a boss's "attack" stat was defined but never used.
const RAID_BOSSES = {
  hollow_choir: {
    key: 'hollow_choir',
    name: 'The Hollow Choir',
    image: 'hollow_choir',
    level: 45,
    maxHp: 15000,
    attack: 80,
    defense: 40,
    totalExpReward: 30000,
    totalGoldReward: 20000,
    itemNames: ["Choir's Discord", "Choir's Vestment", "Choir's Halo", "Choir's Grasp", "Choir's Chime", "Choir's Ward"],
  },
  rift_sovereign: {
    key: 'rift_sovereign',
    name: 'The Rift Sovereign',
    image: 'rift_sovereign',
    level: 55,
    maxHp: 30000,
    attack: 150,
    defense: 60,
    totalExpReward: 60000,
    totalGoldReward: 40000,
    itemNames: [
      "Sovereign's Blade", "Sovereign's Plate", "Sovereign's Crown",
      "Sovereign's Grasp", "Sovereign's Greaves", "Sovereign's Stride",
      "Sovereign's Chain", "Sovereign's Bulwark",
    ],
  },
  unraveled_king: {
    key: 'unraveled_king',
    name: 'The Unraveled King',
    image: 'unraveled_king',
    level: 60,
    maxHp: 60000,
    attack: 250,
    defense: 90,
    totalExpReward: 100000,
    totalGoldReward: 70000,
    itemNames: [
      "King's Ruinblade", "King's Plate", "King's Crown",
      "King's Grip", "King's Greaves", "King's Stride",
      "King's Collar", "King's Bulwark",
    ],
  },
};

function getRaidBoss(bossKey) {
  return RAID_BOSSES[bossKey] || RAID_BOSSES.rift_sovereign;
}

function listRaidBosses() {
  return Object.values(RAID_BOSSES).map((b) => ({
    key: b.key, name: b.name, image: b.image, level: b.level,
    maxHp: b.maxHp, attack: b.attack, defense: b.defense,
  }));
}

// The boss's damage to the party each round, scaled by participant count so a bigger raid
// group doesn't automatically trivialize the fight just by having more combined HP - the
// boss hits proportionally harder too, keeping difficulty roughly consistent regardless of
// raid size (3 vs 10).
function computeBossDamageToParty(bossKey, participantCount) {
  const boss = getRaidBoss(bossKey);
  return Math.round(boss.attack * participantCount * (0.85 + Math.random() * 0.3));
}

const GATHERING_WINDOW_MINUTES = 60;
// A real, enforced minimum again - the Leader/Officer can launch whenever they want,
// but only once at least this many members have joined.
const MIN_PARTICIPANTS_TO_LAUNCH = 3;

// Resolved by name at runtime rather than storing IDs here directly, since seed.js is
// what actually creates these rows and ID values shouldn't be assumed/hardcoded outside
// of it.
function getRaidRewardItemIds(bossKey) {
  const boss = getRaidBoss(bossKey);
  return boss.itemNames
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
  RAID_BOSSES, getRaidBoss, listRaidBosses,
  GATHERING_WINDOW_MINUTES, MIN_PARTICIPANTS_TO_LAUNCH,
  getRaidRewardItemIds, expireStaleGatheringRaids, computeBossDamageToParty,
};
