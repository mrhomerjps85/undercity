const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const { computeDerivedStats, computeWorldBossDamage, WORLD_BOSS_ATTACK_COOLDOWN_SECONDS, applyExpGain } = require('../gameLogic');
const { getActivePotionEffects } = require('../potions');
const { getSkillEffects } = require('../skills');
const { getClanPerkEffects, contributeClanXp, canManageClan } = require('../clans');
const { getEquippedBonuses, serializeCharacter, getEquippedWeaponRarity } = require('./character');
const {
  RAID_BOSS, GATHERING_WINDOW_MINUTES, MIN_PARTICIPANTS_TO_ACTIVATE,
  getRaidRewardItemIds, expireStaleGatheringRaids,
} = require('../raids');

const router = express.Router();

function serializeRaid(raid) {
  const participants = db.prepare('SELECT character_id, character_name, damage_dealt FROM raid_participants WHERE raid_id = ? ORDER BY damage_dealt DESC').all(raid.id);
  return {
    id: raid.id,
    status: raid.status,
    bossName: RAID_BOSS.name,
    bossImage: RAID_BOSS.image,
    maxHp: raid.max_hp,
    currentHp: raid.current_hp,
    createdByName: raid.created_by_name,
    gatheringExpiresAt: raid.gathering_expires_at,
    participants,
    minParticipants: MIN_PARTICIPANTS_TO_ACTIVATE,
  };
}

router.get('/current', requireAuth, requireCharacter, (req, res) => {
  if (!req.character.clan_id) {
    return res.status(400).json({ error: 'You are not in a clan.' });
  }
  expireStaleGatheringRaids();
  // Not filtered to just gathering/active - a 'completed' raid stays visible here too
  // (until the clan starts a new one), so anyone who didn't land the killing blow can
  // still see the full reward breakdown afterward, not just whoever got the live response.
  const raid = db.prepare(`
    SELECT * FROM raids WHERE clan_id = ? ORDER BY id DESC LIMIT 1
  `).get(req.character.clan_id);
  if (!raid) {
    return res.json({ raid: null });
  }
  const serialized = serializeRaid(raid);
  if (raid.status === 'completed') {
    serialized.rewardSummary = getRaidRewardSummary(raid.id);
  }
  res.json({ raid: serialized });
});

router.post('/create', requireAuth, requireCharacter, (req, res) => {
  if (!req.character.clan_id) {
    return res.status(400).json({ error: 'You are not in a clan.' });
  }
  if (!canManageClan(req.character)) {
    return res.status(403).json({ error: 'Only the Leader or an Officer can start a raid.' });
  }
  expireStaleGatheringRaids();
  const existing = db.prepare(`
    SELECT id FROM raids WHERE clan_id = ? AND status IN ('gathering', 'active')
  `).get(req.character.clan_id);
  if (existing) {
    return res.status(400).json({ error: 'Your clan already has an active raid.' });
  }

  const gatheringExpiresAt = new Date(Date.now() + GATHERING_WINDOW_MINUTES * 60 * 1000).toISOString();
  const result = db.prepare(`
    INSERT INTO raids (clan_id, status, max_hp, current_hp, created_by_name, gathering_expires_at)
    VALUES (?, 'gathering', ?, ?, ?, ?)
  `).run(req.character.clan_id, RAID_BOSS.maxHp, RAID_BOSS.maxHp, req.character.name, gatheringExpiresAt);

  db.prepare('INSERT INTO raid_participants (raid_id, character_id, character_name) VALUES (?, ?, ?)')
    .run(result.lastInsertRowid, req.character.id, req.character.name);

  const raid = db.prepare('SELECT * FROM raids WHERE id = ?').get(result.lastInsertRowid);
  res.json({ raid: serializeRaid(raid) });
});

router.post('/:id/join', requireAuth, requireCharacter, (req, res) => {
  const raid = db.prepare('SELECT * FROM raids WHERE id = ?').get(req.params.id);
  if (!raid || raid.clan_id !== req.character.clan_id) {
    return res.status(404).json({ error: 'Raid not found.' });
  }
  if (raid.status !== 'gathering' && raid.status !== 'active') {
    return res.status(400).json({ error: 'This raid is no longer joinable.' });
  }
  const already = db.prepare('SELECT id FROM raid_participants WHERE raid_id = ? AND character_id = ?').get(raid.id, req.character.id);
  if (already) {
    return res.status(400).json({ error: 'You already joined this raid.' });
  }

  db.prepare('INSERT INTO raid_participants (raid_id, character_id, character_name) VALUES (?, ?, ?)')
    .run(raid.id, req.character.id, req.character.name);

  const participantCount = db.prepare('SELECT COUNT(*) c FROM raid_participants WHERE raid_id = ?').get(raid.id).c;
  if (raid.status === 'gathering' && participantCount >= MIN_PARTICIPANTS_TO_ACTIVATE) {
    db.prepare("UPDATE raids SET status = 'active' WHERE id = ?").run(raid.id);
  }

  const updated = db.prepare('SELECT * FROM raids WHERE id = ?').get(raid.id);
  res.json({ raid: serializeRaid(updated) });
});

router.post('/:id/attack', requireAuth, requireCharacter, (req, res) => {
  const raid = db.prepare('SELECT * FROM raids WHERE id = ?').get(req.params.id);
  if (!raid || raid.clan_id !== req.character.clan_id) {
    return res.status(404).json({ error: 'Raid not found.' });
  }
  if (raid.status !== 'active') {
    return res.status(400).json({ error: raid.status === 'gathering' ? `Needs ${MIN_PARTICIPANTS_TO_ACTIVATE} participants before it can be attacked.` : 'This raid has already ended.' });
  }
  const participant = db.prepare('SELECT * FROM raid_participants WHERE raid_id = ? AND character_id = ?').get(raid.id, req.character.id);
  if (!participant) {
    return res.status(403).json({ error: 'You must join this raid before attacking it.' });
  }
  if (participant.last_attack_at) {
    const elapsed = (Date.now() - new Date(participant.last_attack_at).getTime()) / 1000;
    if (elapsed < WORLD_BOSS_ATTACK_COOLDOWN_SECONDS) {
      return res.status(429).json({ error: `Wait ${Math.ceil(WORLD_BOSS_ATTACK_COOLDOWN_SECONDS - elapsed)}s before attacking again.` });
    }
  }

  const bonuses = getEquippedBonuses(req.character.id);
  const derived = computeDerivedStats(req.character, bonuses);
  const potionEffects = getActivePotionEffects(req.character.id);
  const skillEffects = getSkillEffects(req.character.id);
  const clanEffects = getClanPerkEffects(req.character.clan_id);
  const weaponRarity = getEquippedWeaponRarity(req.character.id);
  const boostedAttack = Math.round((derived.attack + skillEffects.atkBonus) * potionEffects.atkMult * clanEffects.atkMult);
  const { damage, isCrit } = computeWorldBossDamage(boostedAttack, RAID_BOSS.defense, weaponRarity, potionEffects.critBonus + skillEffects.critBonus);
  const newHp = Math.max(0, raid.current_hp - damage);
  const now = new Date().toISOString();

  db.prepare('UPDATE raids SET current_hp = ? WHERE id = ?').run(newHp, raid.id);
  db.prepare('UPDATE raid_participants SET damage_dealt = damage_dealt + ?, last_attack_at = ? WHERE id = ?')
    .run(damage, now, participant.id);

  let rewardSummary = null;
  if (newHp <= 0) {
    rewardSummary = distributeRaidRewards(raid.id);
  }

  const updated = db.prepare('SELECT * FROM raids WHERE id = ?').get(raid.id);
  res.json({
    damage, isCrit,
    raid: serializeRaid(updated),
    rewardSummary,
  });
});

// Guaranteed rewards for every participant: EXP/gold split by damage share (same formula
// as world bosses), plus ONE randomly-chosen piece from the exclusive Sovereign's Dominion
// set each - guaranteed, not a %-chance roll, since real coordination effort already
// gates how often a clan can pull this off (no cooldown, but the boss itself is the wall).
function distributeRaidRewards(raidId) {
  const allParticipants = db.prepare('SELECT * FROM raid_participants WHERE raid_id = ?').all(raidId);
  // Only participants who actually dealt damage are "contributors" - simply joining and
  // never attacking doesn't earn a guaranteed reward, matching the design intent (a
  // free-rider shouldn't walk away with the same legendary item as someone who fought).
  const participants = allParticipants.filter((p) => p.damage_dealt > 0);
  const totalDamage = participants.reduce((sum, p) => sum + p.damage_dealt, 0) || 1;
  const rewardItemIds = getRaidRewardItemIds();

  const results = participants.map((p) => {
    const share = p.damage_dealt / totalDamage;
    const potionEffects = getActivePotionEffects(p.character_id);
    const skillEffects = getSkillEffects(p.character_id);
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(p.character_id);
    const clanEffects = getClanPerkEffects(character ? character.clan_id : null);
    const expShare = Math.max(1, Math.round(RAID_BOSS.totalExpReward * share * skillEffects.expMult * potionEffects.expMult));
    const goldShare = Math.max(1, Math.round(RAID_BOSS.totalGoldReward * share * skillEffects.goldMult * potionEffects.goldMult * clanEffects.goldMult));

    let rewardItemName = null;
    if (character) {
      const updatedChar = { ...character };
      applyExpGain(updatedChar, expShare);
      db.prepare('UPDATE characters SET exp = ?, level = ?, attack_points = ?, hp_points = ?, gold = gold + ? WHERE id = ?')
        .run(updatedChar.exp, updatedChar.level, updatedChar.attack_points, updatedChar.hp_points, goldShare, character.id);
      contributeClanXp(character.clan_id, expShare);

      if (rewardItemIds.length > 0) {
        const chosenItemId = rewardItemIds[Math.floor(Math.random() * rewardItemIds.length)];
        db.prepare('INSERT INTO character_inventory (character_id, item_template_id) VALUES (?, ?)').run(character.id, chosenItemId);
        const item = db.prepare('SELECT name FROM item_templates WHERE id = ?').get(chosenItemId);
        rewardItemName = item.name;
      }
    }

    return {
      characterId: p.character_id,
      characterName: p.character_name,
      damageDealt: p.damage_dealt,
      damageSharePct: Math.round(share * 1000) / 10,
      expShare,
      goldShare,
      rewardItemName,
    };
  });

  db.prepare("UPDATE raids SET status = 'completed', completed_at = ?, reward_summary_json = ? WHERE id = ?")
    .run(new Date().toISOString(), JSON.stringify(results), raidId);
  return results;
}

function getRaidRewardSummary(raidId) {
  const raid = db.prepare('SELECT reward_summary_json FROM raids WHERE id = ?').get(raidId);
  return raid && raid.reward_summary_json ? JSON.parse(raid.reward_summary_json) : null;
}

module.exports = router;
