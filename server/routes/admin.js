const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db/db');
const { requireAuth } = require('../middleware');

const router = express.Router();

function requireAdmin(req, res, next) {
  const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !user.is_admin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// List/search players. Optional ?search= filters by username or character name.
router.get('/players', requireAuth, requireAdmin, (req, res) => {
  const { search } = req.query;
  let rows;
  if (search) {
    const term = `%${search}%`;
    rows = db.prepare(`
      SELECT u.id as user_id, u.username, u.is_admin, u.banned, u.created_at as account_created_at,
             c.id as character_id, c.name as character_name, c.level, c.gold, c.current_room_id
      FROM users u
      LEFT JOIN characters c ON c.user_id = u.id
      WHERE u.username LIKE ? OR c.name LIKE ?
      ORDER BY u.id DESC LIMIT 100
    `).all(term, term);
  } else {
    rows = db.prepare(`
      SELECT u.id as user_id, u.username, u.is_admin, u.banned, u.created_at as account_created_at,
             c.id as character_id, c.name as character_name, c.level, c.gold, c.current_room_id
      FROM users u
      LEFT JOIN characters c ON c.user_id = u.id
      ORDER BY u.id DESC LIMIT 100
    `).all();
  }
  res.json({ players: rows });
});

router.post('/players/:userId/ban', requireAuth, requireAdmin, (req, res) => {
  const targetId = Number(req.params.userId);
  if (targetId === req.session.userId) {
    return res.status(400).json({ error: "You can't ban your own account." });
  }
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) {
    return res.status(404).json({ error: 'Player not found.' });
  }
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(targetId);
  res.json({ success: true });
});

router.post('/players/:userId/unban', requireAuth, requireAdmin, (req, res) => {
  const targetId = Number(req.params.userId);
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) {
    return res.status(404).json({ error: 'Player not found.' });
  }
  db.prepare('UPDATE users SET banned = 0 WHERE id = ?').run(targetId);
  res.json({ success: true });
});

// Generates a random temporary password and overwrites the account's password_hash
// directly - no email/token flow, since there's no email on file yet. The plaintext is
// returned exactly once in this response; it is never stored or logged anywhere, so the
// admin needs to relay it to the player immediately (Discord, wherever) - there's no way
// to retrieve it again after this call returns.
router.post('/players/:userId/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const targetId = Number(req.params.userId);
  const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetId);
  if (!target) {
    return res.status(404).json({ error: 'Player not found.' });
  }

  const tempPassword = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, targetId);

  res.json({ success: true, username: target.username, tempPassword });
});

// Permanently deletes an account and everything tied to it. Chat messages are kept
// (they store the sender's name as plain text already, so deleting the account doesn't
// break the log for other players) - everything else that only makes sense in the
// context of this specific character is removed.
router.delete('/players/:userId', requireAuth, requireAdmin, (req, res) => {
  const targetId = Number(req.params.userId);
  if (targetId === req.session.userId) {
    return res.status(400).json({ error: "You can't delete your own account." });
  }
  const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetId);
  if (!target) {
    return res.status(404).json({ error: 'Player not found.' });
  }

  const character = db.prepare('SELECT id FROM characters WHERE user_id = ?').get(targetId);
  if (character) {
    // Clear clan leadership before deleting, so no clan is left pointing at a missing character.
    db.prepare('UPDATE clans SET leader_character_id = NULL WHERE leader_character_id = ?').run(character.id);
    db.prepare('DELETE FROM character_inventory WHERE character_id = ?').run(character.id);
    db.prepare('DELETE FROM character_quests WHERE character_id = ?').run(character.id);
    db.prepare('DELETE FROM combat_log WHERE character_id = ?').run(character.id);
    db.prepare('DELETE FROM world_boss_contributions WHERE character_id = ?').run(character.id);
    db.prepare('DELETE FROM characters WHERE id = ?').run(character.id);
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);

  res.json({ success: true, deletedUsername: target.username });
});

// A quick pulse-check on the live world - total players, level spread, world boss status.
router.get('/stats', requireAuth, requireAdmin, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const totalCharacters = db.prepare('SELECT COUNT(*) c FROM characters').get().c;
  const bannedCount = db.prepare('SELECT COUNT(*) c FROM users WHERE banned = 1').get().c;
  const avgLevel = db.prepare('SELECT AVG(level) a FROM characters').get().a;
  const maxLevel = db.prepare('SELECT MAX(level) m FROM characters').get().m;
  const totalGold = db.prepare('SELECT SUM(gold) s FROM characters').get().s;
  const byZone = db.prepare(`
    SELECT z.name as zone_name, COUNT(c.id) as player_count
    FROM zones z
    LEFT JOIN rooms r ON r.zone_id = z.id
    LEFT JOIN characters c ON c.current_room_id = r.id
    GROUP BY z.id ORDER BY player_count DESC
  `).all();
  const worldBosses = db.prepare('SELECT name, current_hp, max_hp, is_alive, respawn_at FROM world_bosses').all();

  res.json({
    totalUsers,
    totalCharacters,
    bannedCount,
    avgLevel: avgLevel ? Math.round(avgLevel * 10) / 10 : 0,
    maxLevel: maxLevel || 0,
    totalGold: totalGold || 0,
    byZone,
    worldBosses,
  });
});

module.exports = router;
