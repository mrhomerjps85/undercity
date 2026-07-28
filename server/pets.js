const db = require('./db/db');

// A small, separate roll on every kill, independent of the existing item-drop roll -
// gives low-level grinding fresh purpose without needing to touch the item drop system.
const PET_DROP_CHANCE = 0.03;

// Weights used only to pick WHICH pet drops once the above roll succeeds - common pets
// are far more likely than mythic ones within that roll, so rarity still means something.
const RARITY_WEIGHTS = { common: 40, uncommon: 25, rare: 18, epic: 10, legendary: 5, mythic: 2 };

function rollPetDrop(characterId) {
  if (Math.random() > PET_DROP_CHANCE) return null;

  const pets = db.prepare('SELECT * FROM pet_templates').all();
  if (pets.length === 0) return null;

  const totalWeight = pets.reduce((sum, p) => sum + (RARITY_WEIGHTS[p.rarity] || 1), 0);
  let roll = Math.random() * totalWeight;
  let chosen = pets[0];
  for (const pet of pets) {
    roll -= (RARITY_WEIGHTS[pet.rarity] || 1);
    if (roll <= 0) { chosen = pet; break; }
  }

  db.prepare('INSERT INTO character_pets (character_id, pet_template_id) VALUES (?, ?)').run(characterId, chosen.id);
  return chosen;
}

// Returns the active pet's bonus, in the same shape callers already combine Skill/Potion/
// Clan effects in - neutral (no bonus) if no pet is active, so always safe to apply.
function getPetEffects(characterId) {
  const neutral = { atkBonus: 0, hpBonus: 0, critBonus: 0, goldMult: 1, expMult: 1 };
  const character = db.prepare('SELECT active_pet_template_id FROM characters WHERE id = ?').get(characterId);
  if (!character || !character.active_pet_template_id) return neutral;

  const pet = db.prepare('SELECT * FROM pet_templates WHERE id = ?').get(character.active_pet_template_id);
  if (!pet) return neutral;

  switch (pet.bonus_type) {
    case 'atk': return { ...neutral, atkBonus: pet.bonus_value };
    case 'hp': return { ...neutral, hpBonus: pet.bonus_value };
    case 'crit': return { ...neutral, critBonus: pet.bonus_value };
    case 'gold': return { ...neutral, goldMult: 1 + pet.bonus_value / 100 };
    case 'exp': return { ...neutral, expMult: 1 + pet.bonus_value / 100 };
    default: return neutral;
  }
}

module.exports = { PET_DROP_CHANCE, RARITY_WEIGHTS, rollPetDrop, getPetEffects };
