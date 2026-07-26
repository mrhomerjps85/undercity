const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const { MAX_UPGRADE_LEVEL, upgradeCost, attemptUpgrade } = require('../gameLogic');
const { serializeCharacter, getActiveSetInfo } = require('./character');

const router = express.Router();

const EQUIPPABLE_SLOTS = ['weapon', 'chest', 'head', 'legs', 'boots', 'hands', 'neck', 'shield'];
const SELL_REFUND_RATE = 0.5; // items refund 50% of their original shop price when sold

router.get('/', requireAuth, requireCharacter, (req, res) => {
  const items = db.prepare(`
    SELECT ci.id as inventory_id, ci.equipped, ci.upgrade_level, ci.protected, it.*, iset.name as set_name
    FROM character_inventory ci
    JOIN item_templates it ON it.id = ci.item_template_id
    LEFT JOIN item_sets iset ON iset.id = it.set_id
    WHERE ci.character_id = ?
    ORDER BY it.is_quest_item ASC, it.slot ASC
  `).all(req.character.id);
  res.json({ items });
});

// Active set bonus info for the character sheet / paper-doll display.
router.get('/sets', requireAuth, requireCharacter, (req, res) => {
  res.json({ sets: getActiveSetInfo(req.character.id) });
});

router.post('/equip', requireAuth, requireCharacter, (req, res) => {
  const { inventoryId } = req.body;
  const invItem = db.prepare(`
    SELECT ci.*, it.slot, it.required_level, it.is_quest_item FROM character_inventory ci
    JOIN item_templates it ON it.id = ci.item_template_id
    WHERE ci.id = ? AND ci.character_id = ?
  `).get(inventoryId, req.character.id);

  if (!invItem) {
    return res.status(404).json({ error: 'Item not found in your inventory.' });
  }
  if (invItem.is_quest_item || !EQUIPPABLE_SLOTS.includes(invItem.slot)) {
    return res.status(400).json({ error: 'That item cannot be equipped.' });
  }
  if (req.character.level < invItem.required_level) {
    return res.status(400).json({ error: `Requires level ${invItem.required_level}.` });
  }

  // Unequip anything else in the same slot first
  db.prepare(`
    UPDATE character_inventory
    SET equipped = 0
    WHERE character_id = ? AND equipped = 1 AND item_template_id IN (
      SELECT id FROM item_templates WHERE slot = ?
    )
  `).run(req.character.id, invItem.slot);

  db.prepare('UPDATE character_inventory SET equipped = 1 WHERE id = ?').run(inventoryId);

  let tutorialCompletedNow = false;
  if (req.character.tutorial_step === 4) {
    const TUTORIAL_COMPLETION_GOLD = 150;
    db.prepare('UPDATE characters SET tutorial_step = 5, gold = gold + ? WHERE id = ?').run(TUTORIAL_COMPLETION_GOLD, req.character.id);
    tutorialCompletedNow = true;
  }

  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({ success: true, character: serializeCharacter(updated), tutorialCompletedNow });
});

router.post('/unequip', requireAuth, requireCharacter, (req, res) => {
  const { inventoryId } = req.body;
  const invItem = db.prepare('SELECT * FROM character_inventory WHERE id = ? AND character_id = ?').get(inventoryId, req.character.id);
  if (!invItem) {
    return res.status(404).json({ error: 'Item not found in your inventory.' });
  }
  db.prepare('UPDATE character_inventory SET equipped = 0 WHERE id = ?').run(inventoryId);
  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({ success: true, character: serializeCharacter(updated) });
});

// Toggle a "protected" flag on an item so it's skipped by bulk salvage, even if it's Common.
router.post('/protect', requireAuth, requireCharacter, (req, res) => {
  const { inventoryId } = req.body;
  const invItem = db.prepare('SELECT * FROM character_inventory WHERE id = ? AND character_id = ?').get(inventoryId, req.character.id);
  if (!invItem) {
    return res.status(404).json({ error: 'Item not found in your inventory.' });
  }
  const newValue = invItem.protected ? 0 : 1;
  db.prepare('UPDATE character_inventory SET protected = ? WHERE id = ?').run(newValue, inventoryId);
  res.json({ success: true, protected: !!newValue });
});

// Bulk-sells every unequipped, unprotected Common-rarity item in one click.
router.post('/sell-all-common', requireAuth, requireCharacter, (req, res) => {
  const candidates = db.prepare(`
    SELECT ci.id as inventory_id, it.price, it.name FROM character_inventory ci
    JOIN item_templates it ON it.id = ci.item_template_id
    WHERE ci.character_id = ? AND ci.equipped = 0 AND ci.protected = 0 AND it.rarity = 'common' AND it.is_quest_item = 0
  `).all(req.character.id);

  let totalRefund = 0;
  for (const item of candidates) {
    const refund = Math.floor(item.price * SELL_REFUND_RATE);
    totalRefund += refund;
    db.prepare('DELETE FROM character_inventory WHERE id = ?').run(item.inventory_id);
  }
  if (totalRefund > 0) {
    db.prepare('UPDATE characters SET gold = gold + ? WHERE id = ?').run(totalRefund, req.character.id);
  }

  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({ success: true, itemsSold: candidates.length, totalRefund, character: serializeCharacter(updated) });
});

// Sell (or discard, for items worth 0 gold like quest items) any owned item.
// Works whether the item is currently equipped or not - selling removes it either way.
router.post('/sell', requireAuth, requireCharacter, (req, res) => {
  const { inventoryId } = req.body;
  const invItem = db.prepare(`
    SELECT ci.*, it.price, it.name FROM character_inventory ci
    JOIN item_templates it ON it.id = ci.item_template_id
    WHERE ci.id = ? AND ci.character_id = ?
  `).get(inventoryId, req.character.id);

  if (!invItem) {
    return res.status(404).json({ error: 'Item not found in your inventory.' });
  }

  const refund = Math.floor(invItem.price * SELL_REFUND_RATE);
  db.prepare('DELETE FROM character_inventory WHERE id = ?').run(inventoryId);
  if (refund > 0) {
    db.prepare('UPDATE characters SET gold = gold + ? WHERE id = ?').run(refund, req.character.id);
  }

  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({ success: true, refund, itemName: invItem.name, character: serializeCharacter(updated) });
});

// Attempt to upgrade an item by one level (risk-based: can fail safely, or - at level 3+ -
// fail and destroy the item). Costs gold up front regardless of outcome.
router.post('/upgrade', requireAuth, requireCharacter, (req, res) => {
  const { inventoryId } = req.body;
  const invItem = db.prepare(`
    SELECT ci.*, it.name, it.is_quest_item, it.slot FROM character_inventory ci
    JOIN item_templates it ON it.id = ci.item_template_id
    WHERE ci.id = ? AND ci.character_id = ?
  `).get(inventoryId, req.character.id);

  if (!invItem) {
    return res.status(404).json({ error: 'Item not found in your inventory.' });
  }
  if (invItem.is_quest_item || !EQUIPPABLE_SLOTS.includes(invItem.slot)) {
    return res.status(400).json({ error: 'That item cannot be upgraded.' });
  }
  if (invItem.upgrade_level >= MAX_UPGRADE_LEVEL) {
    return res.status(400).json({ error: `${invItem.name} is already at the maximum upgrade level (+${MAX_UPGRADE_LEVEL}).` });
  }

  const targetLevel = invItem.upgrade_level + 1;
  const cost = upgradeCost(targetLevel);
  if (req.character.gold < cost) {
    return res.status(400).json({ error: `Not enough gold. Upgrading to +${targetLevel} costs ${cost}.` });
  }

  db.prepare('UPDATE characters SET gold = gold - ? WHERE id = ?').run(cost, req.character.id);

  const result = attemptUpgrade(invItem.upgrade_level);
  if (result.outcome === 'success') {
    db.prepare('UPDATE character_inventory SET upgrade_level = ? WHERE id = ?').run(result.newLevel, inventoryId);
  } else if (result.outcome === 'fail_destroyed') {
    db.prepare('DELETE FROM character_inventory WHERE id = ?').run(inventoryId);
  }
  // fail_safe: gold already spent, item untouched, nothing else to update.

  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({
    outcome: result.outcome,
    itemName: invItem.name,
    newLevel: result.newLevel,
    costPaid: cost,
    character: serializeCharacter(updated),
  });
});

// Shop only lists items whose source is 'shop' - dungeon/quest-exclusive gear isn't purchasable.
router.get('/shop', requireAuth, requireCharacter, (req, res) => {
  const items = db.prepare(`
    SELECT it.*, iset.name as set_name,
           (SELECT COUNT(*) FROM character_inventory ci WHERE ci.character_id = ? AND ci.item_template_id = it.id) as owned_count
    FROM item_templates it
    LEFT JOIN item_sets iset ON iset.id = it.set_id
    WHERE it.source = 'shop' ORDER BY it.required_level ASC
  `).all(req.character.id);
  res.json({ items });
});

router.post('/buy', requireAuth, requireCharacter, (req, res) => {
  const { itemTemplateId } = req.body;
  const item = db.prepare("SELECT * FROM item_templates WHERE id = ? AND source = 'shop'").get(itemTemplateId);
  if (!item) {
    return res.status(404).json({ error: 'Item is not available for purchase.' });
  }
  if (req.character.gold < item.price) {
    return res.status(400).json({ error: 'Not enough gold.' });
  }

  db.prepare('UPDATE characters SET gold = gold - ? WHERE id = ?').run(item.price, req.character.id);
  db.prepare('INSERT INTO character_inventory (character_id, item_template_id) VALUES (?, ?)').run(req.character.id, item.id);

  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({ success: true, character: serializeCharacter(updated) });
});

module.exports = router;
