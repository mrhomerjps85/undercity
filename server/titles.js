const db = require('./db/db');

// The permanent, purchased counterpart to Pets - bought once with gold, owned forever,
// only one active at a time. Kept in code rather than fully data-driven since each title's
// *effect* needs real logic wired into whatever system it touches (Ironhand's effect lives
// in the upgrade endpoint itself, not in a generic multiplier this module could compute).
const TITLE_DEFINITIONS = {
  ironhand: {
    name: 'Ironhand',
    description: 'Your hands never slip. Gear upgrades can still fail, but they will never destroy the item.',
    price: 1000000,
    effectType: 'no_upgrade_destroy',
  },
};

function getActiveTitleEffect(characterId) {
  const character = db.prepare('SELECT active_title_id FROM characters WHERE id = ?').get(characterId);
  if (!character || !character.active_title_id) return { noUpgradeDestroy: false };

  const title = db.prepare('SELECT effect_type FROM title_templates WHERE id = ?').get(character.active_title_id);
  if (!title) return { noUpgradeDestroy: false };

  return { noUpgradeDestroy: title.effect_type === 'no_upgrade_destroy' };
}

module.exports = { TITLE_DEFINITIONS, getActiveTitleEffect };
