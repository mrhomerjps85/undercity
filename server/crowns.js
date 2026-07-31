const db = require('./db/db');

// $4.99 = 500 Crowns, a clean ~$0.01/Crown rate.
const CROWN_PACKAGES = [
  { crowns: 500, priceUsdCents: 499, stripePriceLookupKey: 'crowns_500' },
];

// Deterministic, guaranteed upgrade cost per level - no RNG, no destroy risk. Linear
// (10n - 5): +1=5, +2=15, +3=25, +4=35, +5=45 Crowns, 125 total to fully max one item.
function crownCostForLevel(level) {
  return 10 * level - 5;
}

const MAX_UPGRADE_LEVEL = 5;

function cumulativeCrownCostToLevel(level) {
  let total = 0;
  for (let n = 1; n <= level; n++) total += crownCostForLevel(n);
  return total;
}

// Every balance change goes through here so crown_transactions is always the true
// record of what happened, not just characters.crowns_balance in isolation.
function adjustCrowns(characterId, amount, reason, stripeSessionId = null) {
  const character = db.prepare('SELECT crowns_balance FROM characters WHERE id = ?').get(characterId);
  const newBalance = character.crowns_balance + amount;
  db.prepare('UPDATE characters SET crowns_balance = ? WHERE id = ?').run(newBalance, characterId);
  db.prepare(`
    INSERT INTO crown_transactions (character_id, amount, reason, stripe_session_id, balance_after)
    VALUES (?, ?, ?, ?, ?)
  `).run(characterId, amount, reason, stripeSessionId, newBalance);
  return newBalance;
}

module.exports = {
  CROWN_PACKAGES, MAX_UPGRADE_LEVEL,
  crownCostForLevel, cumulativeCrownCostToLevel, adjustCrowns,
};
