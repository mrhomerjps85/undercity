const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const { computeDerivedStats, applyExpGain } = require('../gameLogic');
const { getActivePotionEffects } = require('../potions');
const { getSkillEffects } = require('../skills');
const { getClanPerkEffects, contributeClanXp, canManageClan } = require('../clans');
const { getEquippedBonuses } = require('./character');
const {
  RAID_BOSS, GATHERING_WINDOW_MINUTES, MIN_PARTICIPANTS_TO_ACTIVATE,
  getRaidRewardItemIds, expireStaleGatheringRaids, computeBossDamageToParty,
} = require('../raids');

const router = express.Router();

// A participant's current fully-boosted Attack (gear + rebirth + tower + skills, then
// potion/clan multipliers) - the same calculation used for every other combat path in the
// game, just computed per-roster-member here instead of for a single attacker.
function getBoostedAttack(character) {
  const bonuses = getEquippedBonuses(character.id);
  const derived = computeDerivedStats(character, bonuses);
  const potionEffects = getActivePotionEffects(character.id);
  const skillEffects = getSkillEffects(character.id);
  const clanEffects = getClanPerkEffects(character.clan_id);
  return Math.round((derived.attack + skillEffects.atkBonus) * potionEffects.atkMult * clanEffects.atkMult);
}

function getBoostedMaxHp(character) {
  const bonuses = getEquippedBonuses(character.id);
  const derived = computeDerivedStats(character, bonuses);
  const potionEffects = getActivePotionEffects(character.id);
  const skillEffects = getSkillEffects(character.id);
  const clanEffects = getClanPerkEffects(character.clan_id);
  return Math.round((derived.maxHp + skillEffects.hpBonus) * potionEffects.hpMult * clanEffects.hpMult);
}

function serializeRaid(raid) {
  const participants = db.prepare('SELECT character_id, character_name, damage_dealt, is_ready FROM raid_participants WHERE raid_id = ? ORDER BY id ASC').all(raid.id);
  const result = {
    id: raid.id,
    status: raid.status,
    bossName: RAID_BOSS.name,
    bossImage: RAID_BOSS.image,
    maxHp: raid.max_hp,
    currentHp: raid.current_hp,
    partyMaxHp: raid.party_max_hp,
    partyCurrentHp: raid.party_current_hp,
    currentRound: raid.current_round,
    createdByName: raid.created_by_name,
    gatheringExpiresAt: raid.gathering_expires_at,
    participants,
    minParticipants: MIN_PARTICIPANTS_TO_ACTIVATE,
  };
  if (raid.status === 'completed' && raid.reward_summary_json) {
    result.rewardSummary = JSON.parse(raid.reward_summary_json);
  }
  return result;
}

router.get('/current', requireAuth, requireCharacter, (req, res) => {
  if (!req.character.clan_id) {
    return res.status(400).json({ error: 'You are not in a clan.' });
  }
  expireStaleGatheringRaids();
  const raid = db.prepare('SELECT * FROM raids WHERE clan_id = ? ORDER BY id DESC LIMIT 1').get(req.character.clan_id);
  res.json({ raid: raid ? serializeRaid(raid) : null });
});

router.post('/create', requireAuth, requireCharacter, (req, res) => {
  if (!req.character.clan_id) {
    return res.status(400).json({ error: 'You are not in a clan.' });
  }
  if (!canManageClan(req.character)) {
    return res.status(403).json({ error: 'Only the Leader or an Officer can start a raid.' });
  }
  expireStaleGatheringRaids();
  const existing = db.prepare(`SELECT id FROM raids WHERE clan_id = ? AND status IN ('gathering', 'active')`).get(req.character.clan_id);
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
  // Roster locks the moment the raid activates - no joining mid-fight, since the party's
  // HP pool is a one-time snapshot taken at activation, not something that can be cleanly
  // topped up by a later arrival.
  if (raid.status !== 'gathering') {
    return res.status(400).json({ error: raid.status === 'active' ? 'This raid has already started - the roster is locked.' : 'This raid is no longer joinable.' });
  }
  const already = db.prepare('SELECT id FROM raid_participants WHERE raid_id = ? AND character_id = ?').get(raid.id, req.character.id);
  if (already) {
    return res.status(400).json({ error: 'You already joined this raid.' });
  }

  db.prepare('INSERT INTO raid_participants (raid_id, character_id, character_name) VALUES (?, ?, ?)')
    .run(raid.id, req.character.id, req.character.name);

  const participants = db.prepare('SELECT character_id FROM raid_participants WHERE raid_id = ?').all(raid.id);
  if (participants.length >= MIN_PARTICIPANTS_TO_ACTIVATE) {
    // Snapshot the party's combined Max HP right now, as the roster locks for good.
    let partyMaxHp = 0;
    participants.forEach((p) => {
      const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(p.character_id);
      if (character) partyMaxHp += getBoostedMaxHp(character);
    });
    db.prepare("UPDATE raids SET status = 'active', party_max_hp = ?, party_current_hp = ? WHERE id = ?")
      .run(partyMaxHp, partyMaxHp, raid.id);
  }

  const updated = db.prepare('SELECT * FROM raids WHERE id = ?').get(raid.id);
  res.json({ raid: serializeRaid(updated) });
});

router.post('/:id/ready', requireAuth, requireCharacter, (req, res) => {
  const raid = db.prepare('SELECT * FROM raids WHERE id = ?').get(req.params.id);
  if (!raid || raid.clan_id !== req.character.clan_id) {
    return res.status(404).json({ error: 'Raid not found.' });
  }
  if (raid.status !== 'active') {
    return res.status(400).json({ error: 'This raid is not currently active.' });
  }
  const participant = db.prepare('SELECT * FROM raid_participants WHERE raid_id = ? AND character_id = ?').get(raid.id, req.character.id);
  if (!participant) {
    return res.status(403).json({ error: 'You are not part of this raid.' });
  }
  db.prepare('UPDATE raid_participants SET is_ready = 1 WHERE id = ?').run(participant.id);

  const updated = db.prepare('SELECT * FROM raids WHERE id = ?').get(raid.id);
  res.json({ raid: serializeRaid(updated) });
});

router.post('/:id/resolve-round', requireAuth, requireCharacter, (req, res) => {
  const raid = db.prepare('SELECT * FROM raids WHERE id = ?').get(req.params.id);
  if (!raid || raid.clan_id !== req.character.clan_id) {
    return res.status(404).json({ error: 'Raid not found.' });
  }
  if (raid.status !== 'active') {
    return res.status(400).json({ error: 'This raid is not currently active.' });
  }
  const participants = db.prepare('SELECT * FROM raid_participants WHERE raid_id = ?').all(raid.id);
  const isParticipant = participants.some((p) => p.character_id === req.character.id);
  if (!isParticipant) {
    return res.status(403).json({ error: 'You are not part of this raid.' });
  }
  const allReady = participants.every((p) => p.is_ready);
  if (!allReady) {
    return res.status(400).json({ error: 'Not everyone has readied up yet.' });
  }

  // The party's summed Attack this round, computed fresh from each member's CURRENT stats
  // (gear/potions/skills/clan can all have changed since the last round) - not a stale
  // snapshot, only party_max_hp/party_current_hp are ever snapshotted.
  let roundDamageToBoss = 0;
  participants.forEach((p) => {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(p.character_id);
    if (!character) return;
    const atk = getBoostedAttack(character);
    roundDamageToBoss += atk;
    db.prepare('UPDATE raid_participants SET damage_dealt = damage_dealt + ?, is_ready = 0 WHERE id = ?').run(atk, p.id);
  });

  const bossDamageToParty = computeBossDamageToParty(participants.length);
  const newBossHp = Math.max(0, raid.current_hp - roundDamageToBoss);
  const newPartyHp = Math.max(0, raid.party_current_hp - bossDamageToParty);

  let rewardSummary = null;
  let newStatus = 'active';

  if (newBossHp <= 0) {
    newStatus = 'completed';
    rewardSummary = distributeRaidRewards(raid.id);
  } else if (newPartyHp <= 0) {
    newStatus = 'failed';
    db.prepare("UPDATE raids SET status = 'failed', current_hp = ?, party_current_hp = 0, completed_at = ? WHERE id = ?")
      .run(newBossHp, new Date().toISOString(), raid.id);
  } else {
    db.prepare('UPDATE raids SET current_hp = ?, party_current_hp = ?, current_round = current_round + 1 WHERE id = ?')
      .run(newBossHp, newPartyHp, raid.id);
  }

  const updated = db.prepare('SELECT * FROM raids WHERE id = ?').get(raid.id);
  res.json({
    roundDamageToBoss, bossDamageToParty,
    raid: serializeRaid(updated),
  });
});

// Guaranteed rewards for every participant who dealt damage across the whole fight
// (cumulative damage_dealt, not just the final round) - split by their overall damage
// share, plus one randomly-chosen piece from the exclusive Sovereign's Dominion set each.
function distributeRaidRewards(raidId) {
  const allParticipants = db.prepare('SELECT * FROM raid_participants WHERE raid_id = ?').all(raidId);
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

  db.prepare("UPDATE raids SET status = 'completed', current_hp = 0, completed_at = ?, reward_summary_json = ? WHERE id = ?")
    .run(new Date().toISOString(), JSON.stringify(results), raidId);
  return results;
}

module.exports = router;
