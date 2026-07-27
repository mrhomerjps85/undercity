const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');

const router = express.Router();

const EXPIRY_HOURS = 72;
const MARKETPLACE_CUT = 0.10; // 10% taken from the seller's proceeds when something sells - the gold sink

function parseTimestamp(str) {
  if (!str) return 0;
  if (str.includes('T')) return new Date(str).getTime();
  return new Date(str.replace(' ', 'T') + 'Z').getTime();
}

// Lazily expires stale listings and returns the item/material to the seller - same
// respawn-style "check on read" pattern used throughout this app instead of a background
// job. Called at the top of every route that reads or mutates listings.
function expireStaleListings() {
  const cutoff = Date.now() - EXPIRY_HOURS * 60 * 60 * 1000;
  const stale = db.prepare("SELECT * FROM marketplace_listings WHERE status = 'active'").all()
    .filter((l) => parseTimestamp(l.listed_at) < cutoff);

  for (const listing of stale) {
    returnListingToSeller(listing);
    db.prepare("UPDATE marketplace_listings SET status = 'expired', resolved_at = ? WHERE id = ?")
      .run(new Date().toISOString(), listing.id);
  }
}

function returnListingToSeller(listing) {
  if (listing.listing_type === 'equipment') {
    db.prepare('INSERT INTO character_inventory (character_id, item_template_id, upgrade_level) VALUES (?, ?, ?)')
      .run(listing.seller_character_id, listing.item_template_id, listing.upgrade_level);
  } else {
    db.prepare(`
      INSERT INTO character_materials (character_id, material_id, quantity) VALUES (?, ?, ?)
      ON CONFLICT(character_id, material_id) DO UPDATE SET quantity = quantity + excluded.quantity
    `).run(listing.seller_character_id, listing.material_id, listing.quantity);
  }
}

router.get('/listings', requireAuth, requireCharacter, (req, res) => {
  expireStaleListings();
  const listings = db.prepare(`
    SELECT ml.*,
           it.name as item_name, it.slot, it.rarity as item_rarity, it.image as item_image,
           it.bonus_atk, it.bonus_hp,
           cm.name as material_name, cm.image as material_image
    FROM marketplace_listings ml
    LEFT JOIN item_templates it ON it.id = ml.item_template_id
    LEFT JOIN crafting_materials cm ON cm.id = ml.material_id
    WHERE ml.status = 'active'
    ORDER BY ml.listed_at DESC
    LIMIT 100
  `).all();
  res.json({ listings });
});

router.get('/my-listings', requireAuth, requireCharacter, (req, res) => {
  expireStaleListings();
  const listings = db.prepare(`
    SELECT ml.*,
           it.name as item_name, it.slot, it.rarity as item_rarity, it.image as item_image,
           cm.name as material_name, cm.image as material_image
    FROM marketplace_listings ml
    LEFT JOIN item_templates it ON it.id = ml.item_template_id
    LEFT JOIN crafting_materials cm ON cm.id = ml.material_id
    WHERE ml.seller_character_id = ? AND ml.status != 'cancelled'
    ORDER BY ml.listed_at DESC
    LIMIT 100
  `).all(req.character.id);
  res.json({ listings });
});

router.post('/list-equipment', requireAuth, requireCharacter, (req, res) => {
  const { inventoryId, price } = req.body;
  if (!price || price < 1) {
    return res.status(400).json({ error: 'Price must be at least 1 gold.' });
  }
  const invItem = db.prepare('SELECT * FROM character_inventory WHERE id = ? AND character_id = ?').get(inventoryId, req.character.id);
  if (!invItem) {
    return res.status(404).json({ error: 'Item not found in your inventory.' });
  }
  if (invItem.equipped) {
    return res.status(400).json({ error: 'Unequip this item before listing it.' });
  }

  db.prepare('DELETE FROM character_inventory WHERE id = ?').run(inventoryId);
  db.prepare(`
    INSERT INTO marketplace_listings (seller_character_id, seller_name, listing_type, item_template_id, upgrade_level, price)
    VALUES (?, ?, 'equipment', ?, ?, ?)
  `).run(req.character.id, req.character.name, invItem.item_template_id, invItem.upgrade_level, Math.floor(price));

  res.json({ success: true });
});

router.post('/list-material', requireAuth, requireCharacter, (req, res) => {
  const { materialId, quantity, price } = req.body;
  if (!price || price < 1) {
    return res.status(400).json({ error: 'Price must be at least 1 gold.' });
  }
  if (!quantity || quantity < 1) {
    return res.status(400).json({ error: 'Quantity must be at least 1.' });
  }
  const owned = db.prepare('SELECT quantity FROM character_materials WHERE character_id = ? AND material_id = ?')
    .get(req.character.id, materialId);
  const ownedQty = owned ? owned.quantity : 0;
  if (ownedQty < quantity) {
    return res.status(400).json({ error: `You only have ${ownedQty} of that material.` });
  }

  db.prepare('UPDATE character_materials SET quantity = quantity - ? WHERE character_id = ? AND material_id = ?')
    .run(quantity, req.character.id, materialId);
  db.prepare(`
    INSERT INTO marketplace_listings (seller_character_id, seller_name, listing_type, material_id, quantity, price)
    VALUES (?, ?, 'material', ?, ?, ?)
  `).run(req.character.id, req.character.name, materialId, Math.floor(quantity), Math.floor(price));

  res.json({ success: true });
});

router.post('/buy/:listingId', requireAuth, requireCharacter, (req, res) => {
  expireStaleListings();
  const listing = db.prepare("SELECT * FROM marketplace_listings WHERE id = ? AND status = 'active'").get(req.params.listingId);
  if (!listing) {
    return res.status(404).json({ error: 'That listing is no longer available.' });
  }
  if (listing.seller_character_id === req.character.id) {
    return res.status(400).json({ error: "You can't buy your own listing." });
  }
  if (req.character.gold < listing.price) {
    return res.status(400).json({ error: `Not enough gold - need ${listing.price}.` });
  }

  const sellerProceeds = Math.floor(listing.price * (1 - MARKETPLACE_CUT));

  db.prepare('UPDATE characters SET gold = gold - ? WHERE id = ?').run(listing.price, req.character.id);
  db.prepare('UPDATE characters SET gold = gold + ? WHERE id = ?').run(sellerProceeds, listing.seller_character_id);

  if (listing.listing_type === 'equipment') {
    db.prepare('INSERT INTO character_inventory (character_id, item_template_id, upgrade_level) VALUES (?, ?, ?)')
      .run(req.character.id, listing.item_template_id, listing.upgrade_level);
  } else {
    db.prepare(`
      INSERT INTO character_materials (character_id, material_id, quantity) VALUES (?, ?, ?)
      ON CONFLICT(character_id, material_id) DO UPDATE SET quantity = quantity + excluded.quantity
    `).run(req.character.id, listing.material_id, listing.quantity);
  }

  db.prepare("UPDATE marketplace_listings SET status = 'sold', resolved_at = ? WHERE id = ?")
    .run(new Date().toISOString(), listing.id);

  const updated = db.prepare('SELECT gold FROM characters WHERE id = ?').get(req.character.id);
  res.json({ success: true, goldRemaining: updated.gold });
});

router.post('/cancel/:listingId', requireAuth, requireCharacter, (req, res) => {
  const listing = db.prepare("SELECT * FROM marketplace_listings WHERE id = ? AND status = 'active'").get(req.params.listingId);
  if (!listing) {
    return res.status(404).json({ error: 'Listing not found.' });
  }
  if (listing.seller_character_id !== req.character.id) {
    return res.status(403).json({ error: 'This is not your listing.' });
  }

  returnListingToSeller(listing);
  db.prepare("UPDATE marketplace_listings SET status = 'cancelled', resolved_at = ? WHERE id = ?")
    .run(new Date().toISOString(), listing.id);

  res.json({ success: true });
});

module.exports = router;
