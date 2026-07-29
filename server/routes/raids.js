const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const { computeDerivedStats, applyExpGain } = require('../gameLogic');
const { getActivePotionEffects } = require('../potions');
const { getSkillEffects } = require('../skills');
const { getClanPerkEffects, contributeClanXp, canManageClan } = require('../clans');
const { getEquippedBonuses } = require('./character');
const {
  RAID_BOSS, GATHERING_WINDOW_MINUTES, MIN_PARTICIPANTS_TO_LAUNCH,
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
    minParticipantsToLaunch: MIN_PARTICIPANTS_TO_LAUNCH,
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
  // Roster locks the moment the raid launches - no joining mid-fight, since the party's
  // HP pool is a one-time snapshot taken at launch, not something that can be cleanly
  // topped up by a later arrival. Any number of members can join during gathering - no
  // fixed headcount requirement, the Leader/Officer decides when it's time to launch.
  if (raid.status !== 'gathering') {
    return res.status(400).json({ error: raid.status === 'active' ? 'This raid has already launched - the roster is locked.' : 'This raid is no longer joinable.' });
  }
  const already = db.prepare('SELECT id FROM raid_participants WHERE raid_id = ? AND character_id = ?').get(raid.id, req.character.id);
  if (already) {
    return res.status(400).json({ error: 'You already joined this raid.' });
  }

  db.prepare('INSERT INTO raid_participants (raid_id, character_id, character_name) VALUES (?, ?, ?)')
    .run(raid.id, req.character.id, req.character.name);

  const updated = db.prepare('SELECT * FROM raids WHERE id = ?').get(raid.id);
  res.json({ raid: serializeRaid(updated) });
});

// The Leader/Officer decides when to launch, with however many members have joined at
// that point - no automatic activation at a fixed headcount. This is the one moment the
// roster locks and the party's combined Max HP gets snapshotted as the shared health bar.
router.post('/:id/launch', requireAuth, requireCharacter, (req, res) => {
  const raid = db.prepare('SELECT * FROM raids WHERE id = ?').get(req.params.id);
  if (!raid || raid.clan_id !== req.character.clan_id) {
    return res.status(404).json({ error: 'Raid not found.' });
  }
  if (!canManageClan(req.character)) {
    return res.status(403).json({ error: 'Only the Leader or an Officer can launch the raid.' });
  }
  if (raid.status !== 'gathering') {
    return res.status(400).json({ error: 'This raid has already launched.' });
  }
  const participants = db.prepare('SELECT character_id FROM raid_participants WHERE raid_id = ?').all(raid.id);
  if (participants.length < MIN_PARTICIPANTS_TO_LAUNCH) {
    return res.status(400).json({ error: `Need at least ${MIN_PARTICIPANTS_TO_LAUNCH} members to launch (currently ${participants.length}).` });
  }

  let partyMaxHp = 0;
  participants.forEach((p) => {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(p.character_id);
    if (character) partyMaxHp += getBoostedMaxHp(character);
  });
  db.prepare("UPDATE raids SET status = 'active', party_max_hp = ?, party_current_hp = ? WHERE id = ?")
    .run(partyMaxHp, partyMaxHp, raid.id);

  const updated = db.prepare('SELECT * FROM raids WHERE id = ?').get(raid.id);
  res.json({ raid: serializeRaid(updated) });
});

// Runs the ENTIRE fight to its conclusion in one call, once everyone has readied up -
// no more repeating the ready-up cycle every single round, which is what made the
// original per-round design tedious in practice (confirmed by actual play). Each
// participant's Attack is computed once at the start (not re-queried every simulated
// round - there's no meaningful time for gear/potions to change mid-resolution anyway),
// and the loop runs until either side hits 0, capped defensively so a freak edge case
// (e.g. a party with 0 combined Attack) can't hang the server.
const MAX_SIMULATED_ROUNDS = 500;

router.post('/:id/start', requireAuth, requireCharacter, (req, res) => {
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

  const attackByParticipant = {};
  let totalPartyAttack = 0;
  participants.forEach((p) => {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(p.character_id);
    const atk = character ? getBoostedAttack(character) : 0;
    attackByParticipant[p.id] = atk;
    totalPartyAttack += atk;
  });

  let bossHp = raid.current_hp;
  let partyHp = raid.party_current_hp;
  let round = raid.current_round;
  const roundLog = [];

  while (bossHp > 0 && partyHp > 0 && round - raid.current_round < MAX_SIMULATED_ROUNDS) {
    bossHp = Math.max(0, bossHp - totalPartyAttack);
    const bossDamage = computeBossDamageToParty(participants.length);
    partyHp = Math.max(0, partyHp - bossDamage);
    roundLog.push({ round, damageToBoss: totalPartyAttack, damageToParty: bossDamage });
    participants.forEach((p) => {
      db.prepare('UPDATE raid_participants SET damage_dealt = damage_dealt + ? WHERE id = ?').run(attackByParticipant[p.id], p.id);
    });
    round += 1;
    if (bossHp <= 0 || partyHp <= 0) break;
  }

  let rewardSummary = null;
  if (bossHp <= 0) {
    rewardSummary = distributeRaidRewards(raid.id);
  } else if (partyHp <= 0) {
    db.prepare("UPDATE raids SET status = 'failed', current_hp = ?, party_current_hp = 0, current_round = ?, completed_at = ? WHERE id = ?")
      .run(bossHp, round, new Date().toISOString(), raid.id);
  } else {
    // Hit the safety cap without a resolution - leave it active at the new HP/round so
    // the party can simply Start again to keep going, rather than losing progress.
    db.prepare('UPDATE raids SET current_hp = ?, party_current_hp = ?, current_round = ? WHERE id = ?')
      .run(bossHp, partyHp, round, raid.id);
  }

  const updated = db.prepare('SELECT * FROM raids WHERE id = ?').get(raid.id);
  res.json({ roundsFought: roundLog.length, roundLog, raid: serializeRaid(updated) });
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
