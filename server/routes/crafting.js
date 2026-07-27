const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const { serializeCharacter } = require('./character');

const router = express.Router();

// Character's current material quantities, with material metadata joined in for display.
router.get('/materials', requireAuth, requireCharacter, (req, res) => {
  const materials = db.prepare(`
    SELECT cm.id, cm.name, cm.tier, cm.slot, cm.image, cm.description, COALESCE(chm.quantity, 0) as quantity
    FROM crafting_materials cm
    LEFT JOIN character_materials chm ON chm.material_id = cm.id AND chm.character_id = ?
    ORDER BY cm.tier ASC, cm.slot ASC
  `).all(req.character.id);
  res.json({ materials });
});

// All 24 recipes, each annotated with how many of the needed material the character
// currently has, so the frontend can show real progress (e.g. "3/5") and grey out
// anything not yet craftable rather than the player finding out only after clicking.
router.get('/recipes', requireAuth, requireCharacter, (req, res) => {
  const recipes = db.prepare(`
    SELECT cr.item_template_id, cr.materials_needed, cr.gold_cost,
           it.name as item_name, it.slot, it.required_level, it.rarity, it.image as item_image,
           it.bonus_atk, it.bonus_hp,
           cm.id as material_id, cm.name as material_name, cm.tier, cm.image as material_image,
           COALESCE(chm.quantity, 0) as owned_quantity,
           (SELECT COUNT(*) FROM character_inventory ci WHERE ci.character_id = ? AND ci.item_template_id = cr.item_template_id) as owned_item_count
    FROM crafting_recipes cr
    JOIN item_templates it ON it.id = cr.item_template_id
    JOIN crafting_materials cm ON cm.id = cr.material_id
    LEFT JOIN character_materials chm ON chm.material_id = cm.id AND chm.character_id = ?
    ORDER BY cm.tier ASC, it.slot ASC
  `).all(req.character.id, req.character.id);

  res.json({
    recipes: recipes.map((r) => ({
      ...r,
      craftable: r.owned_quantity >= r.materials_needed && req.character.gold >= r.gold_cost,
    })),
  });
});

router.post('/craft', requireAuth, requireCharacter, (req, res) => {
  const { itemTemplateId } = req.body;
  const recipe = db.prepare(`
    SELECT cr.*, cm.name as material_name FROM crafting_recipes cr
    JOIN crafting_materials cm ON cm.id = cr.material_id
    WHERE cr.item_template_id = ?
  `).get(itemTemplateId);
  if (!recipe) {
    return res.status(404).json({ error: 'No recipe found for that item.' });
  }

  const owned = db.prepare('SELECT quantity FROM character_materials WHERE character_id = ? AND material_id = ?')
    .get(req.character.id, recipe.material_id);
  const ownedQty = owned ? owned.quantity : 0;

  if (ownedQty < recipe.materials_needed) {
    return res.status(400).json({
      error: `Not enough ${recipe.material_name} - have ${ownedQty}, need ${recipe.materials_needed}.`,
    });
  }
  if (req.character.gold < recipe.gold_cost) {
    return res.status(400).json({ error: `Not enough gold - need ${recipe.gold_cost}.` });
  }

  db.prepare('UPDATE character_materials SET quantity = quantity - ? WHERE character_id = ? AND material_id = ?')
    .run(recipe.materials_needed, req.character.id, recipe.material_id);
  db.prepare('UPDATE characters SET gold = gold - ? WHERE id = ?').run(recipe.gold_cost, req.character.id);
  db.prepare('INSERT INTO character_inventory (character_id, item_template_id) VALUES (?, ?)').run(req.character.id, itemTemplateId);

  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({ success: true, character: serializeCharacter(updated) });
});

module.exports = router;
