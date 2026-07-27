const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const { serializeCharacter } = require('./character');
const {
  expToNextClanLevel, memberCapForLevel, clanPerkPercent, getClan, canManageClan,
} = require('../clans');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const clans = db.prepare(`
    SELECT cl.id, cl.name, cl.clan_level, COUNT(c.id) as member_count
    FROM clans cl
    LEFT JOIN characters c ON c.clan_id = cl.id
    GROUP BY cl.id
    ORDER BY cl.clan_level DESC, member_count DESC
  `).all();
  res.json({ clans });
});

router.post('/create', requireAuth, requireCharacter, (req, res) => {
  const { name } = req.body;
  if (!name || name.length < 3 || name.length > 25) {
    return res.status(400).json({ error: 'Clan name must be 3-25 characters.' });
  }
  if (req.character.clan_id) {
    return res.status(400).json({ error: 'You are already in a clan. Leave it first.' });
  }
  const existing = db.prepare('SELECT id FROM clans WHERE name = ?').get(name);
  if (existing) {
    return res.status(409).json({ error: 'That clan name is taken.' });
  }

  const result = db.prepare('INSERT INTO clans (name, leader_character_id) VALUES (?, ?)').run(name, req.character.id);
  db.prepare("UPDATE characters SET clan_id = ?, clan_role = 'leader' WHERE id = ?").run(result.lastInsertRowid, req.character.id);

  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({ success: true, character: serializeCharacter(updated) });
});

router.post('/join', requireAuth, requireCharacter, (req, res) => {
  const { clanId } = req.body;
  const clan = getClan(clanId);
  if (!clan) {
    return res.status(404).json({ error: 'Clan not found.' });
  }
  if (req.character.clan_id) {
    return res.status(400).json({ error: 'You are already in a clan. Leave it first.' });
  }

  const memberCount = db.prepare('SELECT COUNT(*) c FROM characters WHERE clan_id = ?').get(clanId).c;
  if (memberCount >= memberCapForLevel(clan.clan_level)) {
    return res.status(400).json({ error: 'This clan is full.' });
  }

  db.prepare("UPDATE characters SET clan_id = ?, clan_role = 'member' WHERE id = ?").run(clanId, req.character.id);
  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({ success: true, character: serializeCharacter(updated) });
});

router.post('/leave', requireAuth, requireCharacter, (req, res) => {
  if (!req.character.clan_id) {
    return res.status(400).json({ error: 'You are not in a clan.' });
  }
  if (req.character.clan_role === 'leader') {
    const memberCount = db.prepare('SELECT COUNT(*) c FROM characters WHERE clan_id = ? AND id != ?').get(req.character.clan_id, req.character.id).c;
    if (memberCount > 0) {
      return res.status(400).json({ error: 'Promote another member to Leader before leaving, or the clan will be leaderless.' });
    }
    // Last member leaving - the clan is disbanded rather than left leaderless forever.
    db.prepare('DELETE FROM clan_vault_items WHERE clan_id = ?').run(req.character.clan_id);
    db.prepare('DELETE FROM clans WHERE id = ?').run(req.character.clan_id);
  }
  db.prepare("UPDATE characters SET clan_id = NULL, clan_role = 'member' WHERE id = ?").run(req.character.id);
  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({ success: true, character: serializeCharacter(updated) });
});

// Clan overview - level, XP progress, member cap, and the current perk %, shown to any
// member so everyone can see what their clan is working toward.
router.get('/:id/info', requireAuth, (req, res) => {
  const clan = getClan(req.params.id);
  if (!clan) {
    return res.status(404).json({ error: 'Clan not found.' });
  }
  const memberCount = db.prepare('SELECT COUNT(*) c FROM characters WHERE clan_id = ?').get(clan.id).c;
  res.json({
    clan: {
      ...clan,
      memberCount,
      memberCap: memberCapForLevel(clan.clan_level),
      expToNextLevel: expToNextClanLevel(clan.clan_level),
      perkPercent: clanPerkPercent(clan.clan_level),
    },
  });
});

router.get('/:id/roster', requireAuth, (req, res) => {
  const members = db.prepare(`
    SELECT id, name, level, clan_role FROM characters WHERE clan_id = ?
    ORDER BY CASE clan_role WHEN 'leader' THEN 0 WHEN 'officer' THEN 1 ELSE 2 END, level DESC
  `).all(req.params.id);
  res.json({ members });
});

// Leaders can promote/demote between officer and member; officers can't touch roles.
router.post('/set-role', requireAuth, requireCharacter, (req, res) => {
  const { characterId, role } = req.body;
  if (req.character.clan_role !== 'leader') {
    return res.status(403).json({ error: 'Only the Leader can change roles.' });
  }
  if (!['officer', 'member'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }
  const target = db.prepare('SELECT * FROM characters WHERE id = ? AND clan_id = ?').get(characterId, req.character.clan_id);
  if (!target) {
    return res.status(404).json({ error: 'That member is not in your clan.' });
  }
  if (target.id === req.character.id) {
    return res.status(400).json({ error: "You can't change your own role." });
  }
  db.prepare('UPDATE characters SET clan_role = ? WHERE id = ?').run(role, target.id);
  res.json({ success: true });
});

// Leaders can kick anyone; Officers can only kick regular Members (not the Leader or
// other Officers) - keeps officer-vs-officer conflicts out of the picture.
router.post('/kick', requireAuth, requireCharacter, (req, res) => {
  const { characterId } = req.body;
  if (!canManageClan(req.character)) {
    return res.status(403).json({ error: 'Only the Leader or an Officer can remove members.' });
  }
  const target = db.prepare('SELECT * FROM characters WHERE id = ? AND clan_id = ?').get(characterId, req.character.clan_id);
  if (!target) {
    return res.status(404).json({ error: 'That member is not in your clan.' });
  }
  if (target.id === req.character.id) {
    return res.status(400).json({ error: "You can't kick yourself - use Leave instead." });
  }
  if (req.character.clan_role === 'officer' && target.clan_role !== 'member') {
    return res.status(403).json({ error: 'Officers can only remove regular Members.' });
  }
  db.prepare("UPDATE characters SET clan_id = NULL, clan_role = 'member' WHERE id = ?").run(target.id);
  res.json({ success: true });
});

// ---------------------------------------------------------------------
// VAULT - deposit an item from your own inventory, or (Leader/Officer) assign a vaulted
// item to a specific member. Not a free-for-all withdraw - items only leave the vault
// when leadership directs them to someone.
// ---------------------------------------------------------------------
router.get('/vault', requireAuth, requireCharacter, (req, res) => {
  if (!req.character.clan_id) {
    return res.status(400).json({ error: 'You are not in a clan.' });
  }
  const items = db.prepare(`
    SELECT cv.id, cv.upgrade_level, cv.donated_by_name, cv.donated_at,
           it.name, it.slot, it.rarity, it.image, it.bonus_atk, it.bonus_hp
    FROM clan_vault_items cv JOIN item_templates it ON it.id = cv.item_template_id
    WHERE cv.clan_id = ? ORDER BY cv.donated_at DESC
  `).all(req.character.clan_id);
  const clan = getClan(req.character.clan_id);
  res.json({ items, vaultGold: clan.vault_gold });
});

router.post('/vault/deposit-item', requireAuth, requireCharacter, (req, res) => {
  if (!req.character.clan_id) {
    return res.status(400).json({ error: 'You are not in a clan.' });
  }
  const { inventoryId } = req.body;
  const invItem = db.prepare('SELECT * FROM character_inventory WHERE id = ? AND character_id = ?').get(inventoryId, req.character.id);
  if (!invItem) {
    return res.status(404).json({ error: 'Item not found in your inventory.' });
  }
  if (invItem.equipped) {
    return res.status(400).json({ error: 'Unequip this item before depositing it.' });
  }

  db.prepare('DELETE FROM character_inventory WHERE id = ?').run(inventoryId);
  db.prepare(`
    INSERT INTO clan_vault_items (clan_id, item_template_id, upgrade_level, donated_by_name)
    VALUES (?, ?, ?, ?)
  `).run(req.character.clan_id, invItem.item_template_id, invItem.upgrade_level, req.character.name);

  res.json({ success: true });
});

router.post('/vault/deposit-gold', requireAuth, requireCharacter, (req, res) => {
  if (!req.character.clan_id) {
    return res.status(400).json({ error: 'You are not in a clan.' });
  }
  const { amount } = req.body;
  const amt = Math.floor(amount);
  if (!amt || amt < 1) {
    return res.status(400).json({ error: 'Enter a valid amount.' });
  }
  if (req.character.gold < amt) {
    return res.status(400).json({ error: 'Not enough gold.' });
  }
  db.prepare('UPDATE characters SET gold = gold - ? WHERE id = ?').run(amt, req.character.id);
  db.prepare('UPDATE clans SET vault_gold = vault_gold + ? WHERE id = ?').run(amt, req.character.clan_id);
  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.character.id);
  res.json({ success: true, character: serializeCharacter(updated) });
});

router.post('/vault/assign-item', requireAuth, requireCharacter, (req, res) => {
  if (!canManageClan(req.character)) {
    return res.status(403).json({ error: 'Only the Leader or an Officer can assign vault items.' });
  }
  const { vaultItemId, targetCharacterId } = req.body;
  const vaultItem = db.prepare('SELECT * FROM clan_vault_items WHERE id = ? AND clan_id = ?').get(vaultItemId, req.character.clan_id);
  if (!vaultItem) {
    return res.status(404).json({ error: 'Vault item not found.' });
  }
  const target = db.prepare('SELECT * FROM characters WHERE id = ? AND clan_id = ?').get(targetCharacterId, req.character.clan_id);
  if (!target) {
    return res.status(404).json({ error: 'That member is not in your clan.' });
  }

  db.prepare('DELETE FROM clan_vault_items WHERE id = ?').run(vaultItemId);
  db.prepare('INSERT INTO character_inventory (character_id, item_template_id, upgrade_level) VALUES (?, ?, ?)')
    .run(target.id, vaultItem.item_template_id, vaultItem.upgrade_level);

  res.json({ success: true });
});

router.post('/vault/assign-gold', requireAuth, requireCharacter, (req, res) => {
  if (!canManageClan(req.character)) {
    return res.status(403).json({ error: 'Only the Leader or an Officer can assign vault gold.' });
  }
  const { amount, targetCharacterId } = req.body;
  const amt = Math.floor(amount);
  const clan = getClan(req.character.clan_id);
  if (!amt || amt < 1 || amt > clan.vault_gold) {
    return res.status(400).json({ error: 'Invalid amount.' });
  }
  const target = db.prepare('SELECT * FROM characters WHERE id = ? AND clan_id = ?').get(targetCharacterId, req.character.clan_id);
  if (!target) {
    return res.status(404).json({ error: 'That member is not in your clan.' });
  }

  db.prepare('UPDATE clans SET vault_gold = vault_gold - ? WHERE id = ?').run(amt, clan.id);
  db.prepare('UPDATE characters SET gold = gold + ? WHERE id = ?').run(amt, target.id);
  res.json({ success: true });
});

module.exports = router;
