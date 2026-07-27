// app.js - Frontend logic for Undercity (Outwar-style clone)
// Handles auth, character creation, world navigation, combat, inventory, shop, clans, leaderboard.

const state = {
  user: null,
  character: null,
  currentRoomDetails: null,
};

// ---------- Tutorial ----------
const TUTORIAL_STEPS = {
  1: { text: "Move to a different room using the arrows or W/A/S/D — look for one with monsters in it.", highlight: '.dpad' },
  2: { text: 'Click Attack on a monster to fight it.', highlight: '#monster-list' },
  3: { text: 'Switch to the Available tab below and accept a quest.', highlight: '.quest-card' },
  4: { text: 'Open your Inventory tab and equip the weapon we gave you.', highlight: '[data-panel="panel-inventory"]' },
};

function clearTutorialHighlight() {
  document.querySelectorAll('.tutorial-highlight').forEach(el => el.classList.remove('tutorial-highlight'));
}

function renderTutorialUI() {
  const modal = document.getElementById('tutorial-welcome-modal');
  const banner = document.getElementById('tutorial-banner');
  clearTutorialHighlight();

  const step = state.character ? state.character.tutorial_step : null;
  if (step === 0) {
    modal.classList.remove('hidden');
    banner.classList.add('hidden');
  } else if (step >= 1 && step <= 4) {
    modal.classList.add('hidden');
    banner.classList.remove('hidden');
    document.getElementById('tutorial-banner-text').textContent = TUTORIAL_STEPS[step].text;
    const target = document.querySelector(TUTORIAL_STEPS[step].highlight);
    if (target) target.classList.add('tutorial-highlight');
  } else {
    modal.classList.add('hidden');
    banner.classList.add('hidden');
  }
}

function applyTutorialStep(newStep) {
  if (newStep === undefined || newStep === null || !state.character) return;
  const wasIncomplete = state.character.tutorial_step < 5;
  state.character.tutorial_step = newStep;
  if (wasIncomplete && newStep >= 5) {
    showToast('Tutorial complete! +150 gold.');
  }
  renderTutorialUI();
}

document.getElementById('tutorial-begin-btn').addEventListener('click', async () => {
  try {
    const data = await api('/character/tutorial/start', { method: 'POST' });
    state.character = data.character;
    updateTopBar();
    renderTutorialUI();
  } catch (err) {
    showToast(err.message, true);
  }
});

async function skipTutorial() {
  try {
    const data = await api('/character/tutorial/skip', { method: 'POST' });
    state.character = data.character;
    renderTutorialUI();
  } catch (err) {
    showToast(err.message, true);
  }
}
document.getElementById('tutorial-skip-btn').addEventListener('click', skipTutorial);
document.getElementById('tutorial-banner-skip-btn').addEventListener('click', skipTutorial);

// ---------- Helpers ----------
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Something went wrong.');
  }
  return data;
}

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 3000);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

// ---------- Boot ----------
async function boot(isRetry = false) {
  try {
    const data = await api('/auth/me');
    state.user = data.user;
    document.getElementById('admin-nav-item').classList.toggle('hidden', !data.user.is_admin);
    document.getElementById('news-badge').classList.toggle('hidden', !data.hasUnreadNews);
    if (data.character) {
      state.character = data.character;
      await enterGame();
    } else {
      showScreen('create-char-screen');
    }
  } catch (err) {
    // A fresh login/register can occasionally be followed by this check before the new
    // session has fully settled server-side. Retry once, briefly, before assuming the
    // person really isn't logged in - avoids bouncing someone straight back to the
    // login screen right after they just successfully signed in.
    if (!isRetry) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return boot(true);
    }
    showScreen('auth-screen');
  }
}

// ---------- Auth ----------
document.getElementById('tab-login').addEventListener('click', () => {
  document.getElementById('tab-login').classList.add('active');
  document.getElementById('tab-register').classList.remove('active');
  document.getElementById('login-form').classList.remove('hidden');
  document.getElementById('register-form').classList.add('hidden');
});
document.getElementById('tab-register').addEventListener('click', () => {
  document.getElementById('tab-register').classList.add('active');
  document.getElementById('tab-login').classList.remove('active');
  document.getElementById('register-form').classList.remove('hidden');
  document.getElementById('login-form').classList.add('hidden');
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    await api('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    await boot();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('register-username').value.trim();
  const password = document.getElementById('register-password').value;
  const errEl = document.getElementById('register-error');
  errEl.textContent = '';
  try {
    await api('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) });
    await boot();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('create-char-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('character-name').value.trim();
  const errEl = document.getElementById('create-char-error');
  errEl.textContent = '';
  try {
    const data = await api('/character', { method: 'POST', body: JSON.stringify({ name }) });
    state.character = data.character;
    await enterGame();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  state.user = null;
  state.character = null;
  showScreen('auth-screen');
});

// ---------- Enter game ----------
async function enterGame() {
  showScreen('game-screen');
  updateTopBar();
  await loadCurrentRoom();
  await loadQuestTracker();
  setupNav();
  connectSocket();
  showChatWidget();
  renderTutorialUI();
}

function updateTopBar() {
  const c = state.character;
  if (!c) return;
  document.getElementById('pill-name').textContent = c.name;
  document.getElementById('pill-level').textContent = c.level;
  document.getElementById('pill-gold').textContent = c.gold;

  document.getElementById('dropdown-attack').textContent = c.attack;
  document.getElementById('dropdown-maxhp').textContent = c.max_hp;
  document.getElementById('dropdown-currenthp').textContent = c.current_hp;

  const expPct = Math.max(0, Math.min(100, (c.exp / c.exp_to_next_level) * 100));
  document.getElementById('exp-fill').style.width = expPct + '%';
  document.getElementById('exp-text').textContent = `${c.exp}/${c.exp_to_next_level}`;

  document.getElementById('tower-nav-item').classList.toggle('hidden', c.level < 10);
}

document.getElementById('level-dropdown-trigger').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('level-dropdown').classList.toggle('hidden');
});
document.addEventListener('click', () => {
  document.getElementById('level-dropdown').classList.add('hidden');
});

// ---------- Nav ----------
function setupNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
      const panel = document.getElementById(btn.dataset.panel);
      panel.classList.remove('hidden');

      if (btn.dataset.panel === 'panel-character') renderCharacterSheet();
      if (btn.dataset.panel === 'panel-inventory') loadInventory();
      if (btn.dataset.panel === 'panel-shop') loadShop();
      if (btn.dataset.panel === 'panel-clan') loadClanPanel();
      if (btn.dataset.panel === 'panel-leaderboard') loadLeaderboard();
      if (btn.dataset.panel === 'panel-admin') loadAdminPanel();
      if (btn.dataset.panel === 'panel-news') loadNewsFeed();
      if (btn.dataset.panel === 'panel-tower') loadTowerPanel();
      if (btn.dataset.panel === 'panel-crafting') loadCraftingPanel();
      if (btn.dataset.panel === 'panel-market') loadMarketPanel();
      if (btn.dataset.panel === 'panel-skills') loadSkillsPanel();
      if (btn.dataset.panel === 'panel-travel') loadTravel();
    }, { once: false });
  });
}

// ---------- World ----------
async function loadCurrentRoom() {
  const data = await api('/world/room/current');
  state.currentRoomDetails = data;
  renderRoom(data);
  applyTutorialStep(data.tutorialStep);
}

function renderRoom(data) {
  const { room, zone, monsters, otherPlayers, exits, respawningCount, worldBoss, npcs } = data;
  document.getElementById('zone-name').textContent = `- ${zone.name} -`;
  document.getElementById('room-name').textContent = `- ${room.name} -`;
  document.getElementById('room-image').innerHTML = `<img src="/images/zones/${zone.image}.svg" alt="${zone.name}" />`;

  renderMinimap(room);
  renderWorldBossCard(worldBoss);
  renderRebirthCard(npcs);
  renderBlacksmithCard(npcs);

  document.querySelectorAll('.dpad-btn').forEach(btn => {
    const dir = btn.dataset.dir;
    btn.disabled = !exits[dir];
  });

  renderRoomPlayersList(document.getElementById('room-players'), otherPlayers);

  const monsterList = document.getElementById('monster-list');
  monsterList.innerHTML = '';
  if (monsters.length === 0) {
    monsterList.innerHTML = '<p class="empty-msg">Nothing here. Move on.</p>';
  } else {
    monsters.forEach(m => {
      const row = document.createElement('div');
      row.className = 'monster-row';
      row.innerHTML = `
        <div class="row-with-icon">
          <img class="row-icon" src="/images/monsters/${m.image}.svg" alt="" />
          <div>
            <span class="name">${m.name}</span>
            <span class="level">Level ${m.level}</span>
            <span class="difficulty-badge difficulty-${m.difficulty}">${m.difficulty}</span>
          </div>
        </div>
        <div class="monster-row-buttons">
          <button class="btn-attack" data-monster-id="${m.room_monster_id}">Attack</button>
          <button class="btn-auto" data-monster-id="${m.room_monster_id}" data-monster-name="${m.name}">Auto</button>
        </div>
      `;
      monsterList.appendChild(row);
    });
    monsterList.querySelectorAll('.btn-attack').forEach(btn => {
      btn.addEventListener('click', () => attackMonster(btn.dataset.monsterId));
    });
    monsterList.querySelectorAll('.btn-auto').forEach(btn => {
      btn.addEventListener('click', () => startAutoAttack(btn.dataset.monsterId, btn.dataset.monsterName));
    });
  }

  const respawnNote = document.getElementById('respawn-note');
  respawnNote.textContent = respawningCount > 0
    ? `${respawningCount} more will respawn here shortly.`
    : '';
}

function renderRoomPlayersList(el, players) {
  el.innerHTML = '';
  if (players.length === 0) return;
  el.appendChild(document.createTextNode('Also here: '));
  players.forEach((p, i) => {
    const link = document.createElement('span');
    link.className = 'player-link';
    link.textContent = `${p.name} (Lv.${p.level})`;
    link.addEventListener('click', () => showProfileModal(p.name));
    el.appendChild(link);
    if (i < players.length - 1) el.appendChild(document.createTextNode(', '));
  });
}

function renderMinimap(room) {
  const minimap = document.getElementById('minimap');
  minimap.innerHTML = '';
  const GRID_SIZE = 9;
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const cell = document.createElement('div');
      const isCurrent = room.grid_x === x && room.grid_y === y;
      cell.className = 'minimap-cell' + (isCurrent ? ' current' : '');
      minimap.appendChild(cell);
    }
  }
}

let currentWorldBossId = null;
let worldBossCooldownUntil = 0;

function renderWorldBossKillModal(logData) {
  if (!logData || !logData.contributors || logData.contributors.length === 0) {
    return;
  }
  document.getElementById('worldboss-kill-title').textContent = `${logData.bossName} - Defeated!`;
  document.getElementById('worldboss-kill-meta').textContent = logData.killedAt
    ? `${logData.contributors.length} contributor${logData.contributors.length > 1 ? 's' : ''} - ${timeAgo(logData.killedAt)}`
    : `${logData.contributors.length} contributor${logData.contributors.length > 1 ? 's' : ''}`;

  const sorted = [...logData.contributors].sort((a, b) => b.damageDealt - a.damageDealt);
  const list = document.getElementById('worldboss-kill-list');
  list.innerHTML = sorted.map((c) => `
    <div class="wbk-row">
      <div>
        <div class="wbk-name">${c.characterName}</div>
        <div class="wbk-damage">${c.damageDealt.toLocaleString()} damage (${c.damageSharePct}%)</div>
        ${c.droppedItems.length ? `<div class="wbk-items">Dropped: ${c.droppedItems.join(', ')}</div>` : ''}
      </div>
      <div class="wbk-rewards">+${c.expShare.toLocaleString()} EXP<br/>+${c.goldShare.toLocaleString()} Gold</div>
    </div>
  `).join('');

  document.getElementById('worldboss-kill-modal').classList.remove('hidden');
}

document.getElementById('worldboss-kill-modal-close').addEventListener('click', () => {
  document.getElementById('worldboss-kill-modal').classList.add('hidden');
});

document.getElementById('worldboss-lastkill-btn').addEventListener('click', async () => {
  if (!currentWorldBossId) return;
  try {
    const data = await api(`/worldboss/${currentWorldBossId}/last-kill`);
    if (!data.log) {
      showToast('This boss has never been defeated yet.', true);
      return;
    }
    renderWorldBossKillModal(data.log);
  } catch (err) {
    showToast(err.message, true);
  }
});

function renderWorldBossCard(worldBoss) {
  const card = document.getElementById('worldboss-card');
  if (!worldBoss) {
    card.classList.add('hidden');
    currentWorldBossId = null;
    return;
  }
  card.classList.remove('hidden');
  currentWorldBossId = worldBoss.id;
  document.getElementById('worldboss-icon').src = `/images/monsters/${worldBoss.image}.svg`;
  document.getElementById('worldboss-name').textContent = worldBoss.name;
  updateWorldBossBar(worldBoss.currentHp, worldBoss.maxHp);
  renderWorldBossContributors(worldBoss.topContributors);

  const statusEl = document.getElementById('worldboss-status');
  const attackBtn = document.getElementById('worldboss-attack-btn');
  if (!worldBoss.isAlive) {
    statusEl.textContent = 'Defeated - will return later.';
    attackBtn.disabled = true;
    attackBtn.textContent = 'Defeated';
  } else {
    statusEl.textContent = 'Everyone in this room can help fight it.';
    attackBtn.disabled = false;
    attackBtn.textContent = 'Attack';
  }
}

// Renders the top-10 damage leaderboard for the boss's current life. Deliberately does
// NOT get cleared when the boss dies - the final standings stay visible until the next
// life starts producing its own contributions (a fresh room load after respawn will pass
// an empty array here naturally, since a new generation has no contributions yet).
function renderWorldBossContributors(topContributors) {
  const container = document.getElementById('worldboss-contributors');
  const list = document.getElementById('worldboss-contributors-list');
  if (!topContributors || topContributors.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  list.innerHTML = topContributors.map((c, i) => `
    <li><span class="wbc-rank">#${i + 1}</span>${c.character_name} <span class="wbc-dmg">${c.damage_dealt.toLocaleString()} dmg</span></li>
  `).join('');
}

function updateWorldBossBar(currentHp, maxHp) {
  const pct = Math.max(0, Math.min(100, (currentHp / maxHp) * 100));
  document.getElementById('worldboss-fill').style.width = pct + '%';
  document.getElementById('worldboss-hp-text').textContent = `${currentHp.toLocaleString()}/${maxHp.toLocaleString()}`;
}

document.getElementById('worldboss-attack-btn').addEventListener('click', async () => {
  if (!currentWorldBossId) return;
  if (Date.now() < worldBossCooldownUntil) return;
  try {
    const data = await api('/worldboss/attack', { method: 'POST', body: JSON.stringify({ worldBossId: currentWorldBossId }) });
    updateWorldBossBar(data.bossCurrentHp, data.bossMaxHp);
    renderWorldBossContributors(data.topContributors);
    showToast(`Hit for ${data.damage} damage!`);
    if (data.bossDefeated && data.defeatSummary) {
      const mine = data.defeatSummary.find(c => c.characterId === state.character.id);
      if (mine) {
        showToast(`Boss defeated! You earned ${mine.expShare} EXP and ${mine.goldShare} gold.${mine.droppedItems.length ? ' Dropped: ' + mine.droppedItems.join(', ') : ''}`);
        state.character.exp += mine.expShare; // optimistic; next character fetch will correct it exactly
        state.character.gold += mine.goldShare;
        updateTopBar();
      }
      document.getElementById('worldboss-status').textContent = 'Defeated - will return later.';
      document.getElementById('worldboss-attack-btn').disabled = true;
      document.getElementById('worldboss-attack-btn').textContent = 'Defeated';
    } else {
      worldBossCooldownUntil = Date.now() + 3000;
      const btn = document.getElementById('worldboss-attack-btn');
      btn.disabled = true;
      let remaining = 3;
      const tick = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(tick);
          btn.disabled = false;
          btn.textContent = 'Attack';
        } else {
          btn.textContent = `Wait ${remaining}s`;
        }
      }, 1000);
    }
  } catch (err) {
    showToast(err.message, true);
  }
});

function renderRebirthCard(npcs) {
  const card = document.getElementById('rebirth-card');
  const elder = npcs && npcs.find((n) => n.npc_type === 'rebirth');
  if (!elder) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  document.getElementById('rebirth-icon').src = `/images/npcs/${elder.image}.svg`;
  document.getElementById('rebirth-name').textContent = elder.name;
  document.getElementById('rebirth-quote').textContent = elder.description || '';

  const eligible = state.character.level >= 50;
  const statusEl = document.getElementById('rebirth-status');
  const btn = document.getElementById('rebirth-btn');
  statusEl.textContent = eligible
    ? `Rebirths so far: ${state.character.rebirth_count || 0}`
    : 'Requires level 50.';
  btn.disabled = !eligible;
}

document.getElementById('rebirth-btn').addEventListener('click', async () => {
  const confirmed = window.confirm(
    'Rebirth? You will return to level 1 with your stat points reset, but keep your gold and ' +
    'inventory. Each rebirth grants a small permanent Attack/HP bonus that stacks forever.'
  );
  if (!confirmed) return;
  try {
    const data = await api('/character/rebirth', { method: 'POST' });
    state.character = data.character;
    updateTopBar();
    showToast(`Reborn! (Rebirth #${data.character.rebirth_count})`);
    await loadCurrentRoom();
  } catch (err) {
    showToast(err.message, true);
  }
});

function renderBlacksmithCard(npcs) {
  const card = document.getElementById('blacksmith-card');
  const smith = npcs && npcs.find((n) => n.npc_type === 'blacksmith');
  if (!smith) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  document.getElementById('blacksmith-icon').src = `/images/npcs/${smith.image}.svg`;
  document.getElementById('blacksmith-name').textContent = smith.name;
  document.getElementById('blacksmith-quote').textContent = smith.description || '';
}

document.getElementById('blacksmith-go-btn').addEventListener('click', () => {
  document.querySelector('.nav-item[data-panel="panel-crafting"]').click();
});

async function movePlayer(direction) {
  if (autoAttackState.active) {
    showToast('Stop auto-attacking before moving.', true);
    return;
  }
  const exits = state.currentRoomDetails ? state.currentRoomDetails.exits : null;
  if (exits && !exits[direction]) return; // no exit that way, silently ignore
  try {
    const data = await api('/world/move', { method: 'POST', body: JSON.stringify({ direction }) });
    state.currentRoomDetails = data;
    renderRoom(data);
    if (socket) socket.emit('room_changed');
    applyTutorialStep(data.tutorialStep);
  } catch (err) {
    showToast(err.message, true);
  }
}

document.querySelectorAll('.dpad-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    movePlayer(btn.dataset.dir);
  });
});

// WASD movement, active whenever the game screen is showing and the world panel
// is in view. Ignored while typing in a text field (forms, quest/clan name inputs, etc).
const WASD_TO_DIRECTION = { w: 'north', a: 'west', s: 'south', d: 'east' };
document.addEventListener('keydown', (e) => {
  if (document.getElementById('game-screen').classList.contains('hidden')) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const direction = WASD_TO_DIRECTION[e.key.toLowerCase()];
  if (!direction) return;
  e.preventDefault();
  movePlayer(direction);
});

// ---------- Combat ----------
async function attackMonster(roomMonsterId) {
  try {
    const data = await api('/combat/attack', { method: 'POST', body: JSON.stringify({ roomMonsterId: Number(roomMonsterId) }) });
    state.character = data.character;
    updateTopBar();
    showCombatModal(data);
    applyTutorialStep(data.character.tutorial_step);
    await loadCurrentRoom();
    await loadQuestTracker();
  } catch (err) {
    showToast(err.message, true);
  }
}

// Auto-attack cycles through whichever instances of a monster are still alive in the
// current room (there are often several duplicates), rather than one specific instance -
// a single attack call already fully resolves that one fight, so re-targeting is what
// makes repeated attacks meaningful here.
let autoAttackState = { active: false, cancelled: false };
const AUTO_ATTACK_MAX_ITERATIONS = 30;
const AUTO_ATTACK_DELAY_MS = 500;

async function startAutoAttack(roomMonsterId, monsterName) {
  if (autoAttackState.active) {
    showToast('Already auto-attacking. Stop it first.', true);
    return;
  }
  autoAttackState = { active: true, cancelled: false };
  const bar = document.getElementById('auto-attack-bar');
  const statusEl = document.getElementById('auto-attack-status');
  bar.classList.remove('hidden');
  document.querySelectorAll('#monster-list .btn-attack, #monster-list .btn-auto').forEach(b => b.disabled = true);

  let kills = 0, totalExp = 0, totalGold = 0;
  let stopReason = `Reached the safety cap (${AUTO_ATTACK_MAX_ITERATIONS} attacks).`;

  for (let i = 0; i < AUTO_ATTACK_MAX_ITERATIONS; i++) {
    if (autoAttackState.cancelled) { stopReason = 'Stopped.'; break; }
    statusEl.textContent = `Auto-attacking ${monsterName}... (${kills} kills, ${totalExp} EXP, ${totalGold} gold)`;

    // Re-check the room each time - some of these duplicate monsters may have
    // already been killed (by us or respawn timing), so find whichever is still alive.
    const roomData = await api('/world/room/current');
    const target = roomData.monsters.find(m => m.name === monsterName);
    if (!target) {
      stopReason = `No more ${monsterName} left here right now.`;
      break;
    }

    let data;
    try {
      data = await api('/combat/attack', { method: 'POST', body: JSON.stringify({ roomMonsterId: target.room_monster_id }) });
    } catch (err) {
      stopReason = err.message;
      break;
    }

    state.character = data.character;
    updateTopBar();

    if (data.victory) {
      kills++;
      totalExp += data.expGained;
      totalGold += data.goldGained;
      if (data.leveledUp) showToast(`Level up! You are now level ${data.character.level}!`);
      if (data.completedQuests && data.completedQuests.length) {
        data.completedQuests.forEach(q => showToast(`Quest complete: ${q.questName}!`));
      }
    } else {
      stopReason = 'You were defeated.';
      break;
    }

    await new Promise(resolve => setTimeout(resolve, AUTO_ATTACK_DELAY_MS));
  }

  autoAttackState.active = false;
  bar.classList.add('hidden');
  await loadCurrentRoom();
  await loadQuestTracker();
  showToast(`Auto-attack done: ${kills} kills, ${totalExp} EXP, ${totalGold} gold. (${stopReason})`);
}

document.getElementById('auto-attack-stop').addEventListener('click', () => {
  autoAttackState.cancelled = true;
});

function showCombatModal(data) {
  const modal = document.getElementById('combat-modal');
  const log = document.getElementById('combat-log');
  const result = document.getElementById('combat-result');

  log.innerHTML = data.log.map(line => `<div>${line}</div>`).join('');
  log.scrollTop = log.scrollHeight;

  if (data.victory) {
    result.className = 'combat-result victory';
    const rows = [];
    rows.push(`<div class="cr-row"><span class="cr-label">EXP</span><span class="cr-value cr-exp">+${data.expGained}</span></div>`);
    rows.push(`<div class="cr-row"><span class="cr-label">Gold</span><span class="cr-value cr-gold">+${data.goldGained}</span></div>`);
    if (data.crits > 0) {
      rows.push(`<div class="cr-row"><span class="cr-label">Critical Hits</span><span class="cr-value cr-crit">${data.crits}</span></div>`);
    }
    if (data.droppedItems && data.droppedItems.length) {
      rows.push(`<div class="cr-row"><span class="cr-label">Items Found</span><span class="cr-value cr-item">${data.droppedItems.join(', ')}</span></div>`);
    }
    if (data.droppedMaterials && data.droppedMaterials.length) {
      rows.push(`<div class="cr-row"><span class="cr-label">Materials Found</span><span class="cr-value cr-material">${data.droppedMaterials.join(', ')}</span></div>`);
    }
    if (data.completedQuests && data.completedQuests.length) {
      rows.push(`<div class="cr-row"><span class="cr-label">Quest Complete</span><span class="cr-value cr-quest">${data.completedQuests.map(q => q.questName).join(', ')}</span></div>`);
    }

    result.innerHTML = `
      <div class="cr-title">Victory!</div>
      ${rows.join('')}
      ${data.leveledUp ? `<div class="cr-levelup">LEVEL UP! You are now level ${data.character.level}${data.levelUpGains ? ` (+${data.levelUpGains.atk} ATK / +${data.levelUpGains.hp} HP)` : ''}</div>` : ''}
    `;
  } else {
    result.className = 'combat-result defeat';
    result.innerHTML = `<div class="cr-title">Defeat</div><div class="cr-row"><span class="cr-label">You were defeated and limp back to the street.</span></div>`;
  }

  modal.classList.remove('hidden');
}

document.getElementById('combat-close').addEventListener('click', () => {
  document.getElementById('combat-modal').classList.add('hidden');
});

// ---------- Character sheet ----------
async function renderCharacterSheet() {
  const c = state.character;
  const sheet = document.getElementById('char-sheet');
  sheet.innerHTML = `
    <div class="stat-box"><div class="label">Attack</div><div class="value">${c.attack}</div></div>
    <div class="stat-box"><div class="label">Max HP</div><div class="value">${c.max_hp}</div></div>
    <div class="stat-box"><div class="label">HP Now</div><div class="value">${c.current_hp}</div></div>
    <div class="stat-box"><div class="label">Level</div><div class="value">${c.level}</div></div>
  `;
  const note = document.createElement('p');
  note.className = 'hint';
  note.style.marginTop = '14px';
  note.textContent = 'Attack and HP increase automatically every level.';
  sheet.appendChild(note);

  try {
    const breakdown = await api('/character/stat-breakdown');
    renderFullBonusBreakdown(breakdown);
    renderCombatInfo(breakdown);
  } catch (err) {
    showToast(err.message, true);
  }
  renderActivePotions();
  loadCombatHistory();
}

function renderFullBonusBreakdown(b) {
  let box = document.getElementById('bonus-breakdown-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'bonus-breakdown-box';
    box.className = 'bonus-breakdown-box';
    document.getElementById('char-sheet').insertAdjacentElement('afterend', box);
  }

  const setRows = b.equipment.activeSets.map((s) => `
    <div class="bonus-row">
      <span class="bonus-source">&nbsp;&nbsp;${s.name} <span class="bonus-count">(${s.pieces}pc)</span></span>
      <span class="bonus-values">+${s.atk} ATK / +${s.hp} HP</span>
    </div>
  `).join('');

  box.innerHTML = `
    <h3 class="subheading">Full Stat Breakdown</h3>
    <div class="bonus-row">
      <span class="bonus-source">Base <span class="bonus-count">(level ${b.level})</span></span>
      <span class="bonus-values">${b.base.atk} ATK / ${b.base.hp} HP</span>
    </div>
    <div class="bonus-row">
      <span class="bonus-source">Allocated Points <span class="bonus-count">(${b.allocatedPoints.attackPoints} ATK pts, ${b.allocatedPoints.hpPoints} HP pts)</span></span>
      <span class="bonus-values">+${b.allocatedPoints.atk} ATK / +${b.allocatedPoints.hp} HP</span>
    </div>
    <div class="bonus-row">
      <span class="bonus-source">Equipment <span class="bonus-count">(items: +${b.equipment.items.atk}/+${b.equipment.items.hp})</span></span>
      <span class="bonus-values">+${b.equipment.atk} ATK / +${b.equipment.hp} HP</span>
    </div>
    ${setRows}
    <div class="bonus-row">
      <span class="bonus-source">Rebirth <span class="bonus-count">(${b.rebirth.count}x)</span></span>
      <span class="bonus-values">+${b.rebirth.atk} ATK / +${b.rebirth.hp} HP</span>
    </div>
    <div class="bonus-row">
      <span class="bonus-source">Tower of Ascension <span class="bonus-count">(${b.tower.milestonesReached}/10 milestones, floor ${b.tower.floor})</span></span>
      <span class="bonus-values">+${b.tower.atk} ATK / +${b.tower.hp} HP</span>
    </div>
    ${b.skills && (b.skills.atk !== 0 || b.skills.hp !== 0) ? `
    <div class="bonus-row">
      <span class="bonus-source">Skills</span>
      <span class="bonus-values">+${b.skills.atk} ATK / +${b.skills.hp} HP</span>
    </div>` : ''}
    ${b.clan && b.clan.inClan ? `
    <div class="bonus-row">
      <span class="bonus-source">Clan Perk <span class="bonus-count">(+${b.clan.perkPercent}%)</span></span>
      <span class="bonus-values">+${b.clan.atk} ATK / +${b.clan.hp} HP</span>
    </div>` : ''}
    ${b.potions.atk !== 0 || b.potions.hp !== 0 ? `
    <div class="bonus-row">
      <span class="bonus-source">Active Potions</span>
      <span class="bonus-values">+${b.potions.atk} ATK / +${b.potions.hp} HP</span>
    </div>` : ''}
    <div class="bonus-row bonus-total">
      <span class="bonus-source">Total (current)</span>
      <span class="bonus-values">${b.final.atk} ATK / ${b.final.hp} HP</span>
    </div>
  `;
}

function renderCombatInfo(b) {
  let box = document.getElementById('combat-info-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'combat-info-box';
    box.className = 'bonus-breakdown-box';
    document.getElementById('bonus-breakdown-box').insertAdjacentElement('afterend', box);
  }
  box.innerHTML = `
    <h3 class="subheading">Combat Info</h3>
    <div class="bonus-row">
      <span class="bonus-source">Weapon Rarity</span>
      <span class="bonus-values rarity-${b.crit.weaponRarity}">${b.crit.weaponRarity}</span>
    </div>
    <div class="bonus-row">
      <span class="bonus-source">Base Crit Chance</span>
      <span class="bonus-values">${b.crit.baseChancePct}%</span>
    </div>
    <div class="bonus-row">
      <span class="bonus-source">Crit Multiplier</span>
      <span class="bonus-values">${b.crit.multiplier}x damage</span>
    </div>
    ${b.crit.skillBonusPct > 0 ? `
    <div class="bonus-row">
      <span class="bonus-source">Precision Skill Bonus</span>
      <span class="bonus-values">+${b.crit.skillBonusPct} pts</span>
    </div>` : ''}
    ${b.crit.potionBonusPct > 0 ? `
    <div class="bonus-row">
      <span class="bonus-source">Crit Elixir Bonus</span>
      <span class="bonus-values">+${b.crit.potionBonusPct} pts</span>
    </div>` : ''}
    <div class="bonus-row bonus-total">
      <span class="bonus-source">Effective Crit Chance</span>
      <span class="bonus-values">${b.crit.effectiveChancePct}%</span>
    </div>
  `;
}

function renderActivePotions() {
  const c = state.character;
  const buffs = c.active_buffs || [];

  let box = document.getElementById('active-potions-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'active-potions-box';
    box.className = 'bonus-breakdown-box';
    const anchor = document.getElementById('combat-info-box') || document.getElementById('bonus-breakdown-box');
    anchor.insertAdjacentElement('afterend', box);
  }

  if (buffs.length === 0) {
    box.innerHTML = '<h3 class="subheading">Active Potions</h3><p class="hint">None active - buy some in the Shop\'s Potions category.</p>';
    return;
  }

  box.innerHTML = `
    <h3 class="subheading">Active Potions</h3>
    ${buffs.map((b) => `
      <div class="bonus-row">
        <span class="bonus-source">${b.name}</span>
        <span class="bonus-values">${Math.floor(b.secondsRemaining / 60)}m ${b.secondsRemaining % 60}s left</span>
      </div>
    `).join('')}
  `;
}

function timeAgo(isoString) {
  const then = new Date(isoString.replace(' ', 'T') + (isoString.includes('T') ? '' : 'Z')).getTime();
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function loadCombatHistory() {
  const data = await api('/combat/history');
  const list = document.getElementById('combat-history-list');
  list.innerHTML = '';
  if (data.entries.length === 0) {
    list.innerHTML = '<p class="empty-msg">No battles yet. Go pick a fight.</p>';
    return;
  }
  data.entries.forEach(e => {
    const row = document.createElement('div');
    row.className = `combat-history-row ${e.result}`;
    const dropParts = [];
    if (e.dropped_items && e.dropped_items.length) {
      dropParts.push(`<span class="ch-drop-item">Items: ${e.dropped_items.join(', ')}</span>`);
    }
    if (e.dropped_materials && e.dropped_materials.length) {
      dropParts.push(`<span class="ch-drop-material">Materials: ${e.dropped_materials.join(', ')}</span>`);
    }
    row.innerHTML = `
      <div class="ch-summary">
        <span class="ch-monster">${e.monster_name}</span>
        <span class="ch-result-${e.result}">${e.result === 'victory' ? 'Won' : 'Lost'}</span>
        <span class="ch-reward">${e.result === 'victory' ? `+${e.exp_gained} EXP / +${e.gold_gained}g` : '—'}</span>
        <span class="ch-time">${timeAgo(e.created_at)}</span>
      </div>
      ${dropParts.length ? `<div class="ch-drops">${dropParts.join(' &nbsp;|&nbsp; ')}</div>` : ''}
    `;
    list.appendChild(row);
  });
}

// ---------- Inventory ----------
const EQUIPMENT_SLOTS = ['head', 'neck', 'chest', 'hands', 'weapon', 'shield', 'legs', 'boots'];
const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

let inventoryItemsCache = [];
let activeInventorySlot = 'all';
let activeInventorySort = 'slot';

async function loadInventory() {
  const data = await api('/inventory');
  inventoryItemsCache = data.items;
  renderPaperdoll(inventoryItemsCache);
  renderDollStats();
  renderInventoryGrid();
  loadSetInfo();
}

async function loadSetInfo() {
  const data = await api('/inventory/sets');
  const el = document.getElementById('set-info');
  if (data.sets.length === 0) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = data.sets.map(s => {
    const activeBonus = [...s.bonusTiers].reverse().find(b => b.pieces_required <= s.equippedCount);
    return `
      <div class="set-name">${s.name} (${s.equippedCount}/${s.totalPieces})</div>
      <div class="set-progress">${s.description || ''}</div>
      ${activeBonus ? `<div class="set-bonus-active">Active: +${activeBonus.bonus_atk} ATK / +${activeBonus.bonus_hp} HP</div>` : ''}
    `;
  }).join('<hr style="border-color: var(--line); margin: 8px 0;">');
}

function renderDollStats() {
  const c = state.character;
  const statsEl = document.getElementById('doll-stats');
  statsEl.innerHTML = `
    <div class="stat-box"><div class="label">Attack</div><div class="value">${c.attack}</div></div>
    <div class="stat-box"><div class="label">Max HP</div><div class="value">${c.max_hp}</div></div>
  `;
}

function renderPaperdoll(items) {
  const equippedBySlot = {};
  items.forEach(item => {
    if (item.equipped) equippedBySlot[item.slot] = item;
  });

  EQUIPMENT_SLOTS.forEach(slot => {
    const slotEl = document.querySelector(`.doll-slot[data-slot="${slot}"]`);
    if (!slotEl) return;
    const equipped = equippedBySlot[slot];
    slotEl.classList.toggle('filled', !!equipped);
    slotEl.classList.toggle('empty', !equipped);
    slotEl.className = slotEl.className.replace(/\brarity-\S+/g, '').trim();
    if (equipped) slotEl.classList.add(`rarity-${equipped.rarity}`);
    const upgradeText = equipped && equipped.upgrade_level > 0 ? ` +${equipped.upgrade_level}` : '';
    slotEl.removeAttribute('title'); // replaced by the custom stat tooltip below
    slotEl.innerHTML = equipped
      ? `<img class="slot-icon" src="/images/items/${equipped.image}.svg" alt="${equipped.name}" />${upgradeText ? `<span class="upgrade-badge">${upgradeText}</span>` : ''}`
      : `<span class="slot-label">${slot.charAt(0).toUpperCase() + slot.slice(1)}</span>`;

    slotEl.onmouseenter = () => { if (equipped) showItemTooltip(slotEl, equipped); };
    slotEl.onmouseleave = () => hideItemTooltip();

    slotEl.onclick = async () => {
      if (!equipped) return; // empty slots: equip from the item list below instead
      try {
        const data2 = await api('/inventory/unequip', { method: 'POST', body: JSON.stringify({ inventoryId: equipped.inventory_id }) });
        state.character = data2.character;
        updateTopBar();
        loadInventory();
      } catch (err) {
        showToast(err.message, true);
      }
    };
  });
}

function showItemTooltip(anchorEl, item) {
  const tooltip = document.getElementById('item-tooltip');
  const stats = effectiveStats(item);
  const statParts = [];
  if (stats.atk) statParts.push(`+${stats.atk} ATK`);
  if (stats.hp) statParts.push(`+${stats.hp} HP`);
  const upgradeText = item.upgrade_level > 0 ? ` +${item.upgrade_level}` : '';

  tooltip.innerHTML = `
    <div class="tt-name rarity-${item.rarity}">${item.name}${upgradeText}</div>
    <div class="tt-meta">${item.slot}, req. Lv.${item.required_level}</div>
    <div class="tt-stats">${statParts.join(' / ') || 'No stat bonus'}</div>
    ${item.set_name ? `<div class="tt-set">Set: ${item.set_name}</div>` : ''}
  `;

  // Fixed positioning is viewport-relative, so this works the same regardless of which
  // panel or modal the anchor element happens to be sitting inside.
  const anchorRect = anchorEl.getBoundingClientRect();
  tooltip.classList.remove('hidden'); // measure only after it's visible, so offsetWidth below is accurate
  const tooltipWidth = tooltip.offsetWidth;
  const spaceOnRight = window.innerWidth - anchorRect.right - 8;
  const left = spaceOnRight >= tooltipWidth
    ? anchorRect.right + 8
    : Math.max(8, anchorRect.left - tooltipWidth - 8); // flip to the left side if it wouldn't fit
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${anchorRect.top}px`;
}

function hideItemTooltip() {
  document.getElementById('item-tooltip').classList.add('hidden');
}

// ---------- Player profiles ----------
async function showProfileModal(characterName) {
  try {
    const data = await api(`/character/profile/${encodeURIComponent(characterName)}`);
    renderProfileModal(data.profile);
    document.getElementById('profile-modal').classList.remove('hidden');
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderProfileModal(profile) {
  document.getElementById('profile-name').textContent = profile.name;
  document.getElementById('profile-meta').textContent =
    `Level ${profile.level}${profile.clanName ? ` — ${profile.clanName}` : ''}`;
  document.getElementById('profile-stats').innerHTML = `
    <div class="stat-box"><div class="label">Attack</div><div class="value">${profile.attack}</div></div>
    <div class="stat-box"><div class="label">Max HP</div><div class="value">${profile.maxHp}</div></div>
  `;

  const setsEl = document.getElementById('profile-sets');
  if (profile.activeSets && profile.activeSets.length > 0) {
    setsEl.innerHTML = profile.activeSets.map(s => {
      const activeBonus = [...s.bonusTiers].reverse().find(b => b.pieces_required <= s.equippedCount);
      return `<div class="profile-set-line">${s.name} (${s.equippedCount}/${s.totalPieces})${activeBonus ? ` — +${activeBonus.bonus_atk} ATK / +${activeBonus.bonus_hp} HP active` : ''}</div>`;
    }).join('');
  } else {
    setsEl.innerHTML = '';
  }

  const equippedBySlot = {};
  profile.equippedItems.forEach(item => { equippedBySlot[item.slot] = item; });

  const grid = document.getElementById('profile-equipment-grid');
  grid.innerHTML = '';
  EQUIPMENT_SLOTS.forEach(slot => {
    const item = equippedBySlot[slot];
    const cell = document.createElement('div');
    cell.className = `profile-equip-slot ${item ? `rarity-${item.rarity}` : 'empty'}`;
    cell.innerHTML = item
      ? `<img src="/images/items/${item.image}.svg" alt="${item.name}" />`
      : `<span class="slot-label">${slot}</span>`;
    if (item) {
      cell.addEventListener('mouseenter', () => showItemTooltip(cell, item));
      cell.addEventListener('mouseleave', hideItemTooltip);
    }
    grid.appendChild(cell);
  });
}

document.getElementById('profile-modal-close').addEventListener('click', () => {
  document.getElementById('profile-modal').classList.add('hidden');
  hideItemTooltip();
});

// Computes this item's effective (upgrade-scaled) stats vs. whatever's currently
// equipped in the same slot, so the player can see if it's actually an upgrade.
// Scales an item's base bonus_atk/bonus_hp by its upgrade level - mirrors the server's
// applyUpgradeMultiplier formula exactly, since this is just a display calculation.
function effectiveStats(item) {
  const mult = 1 + 0.15 * (item.upgrade_level || 0);
  return {
    atk: Math.round(item.bonus_atk * mult),
    hp: Math.round(item.bonus_hp * mult),
  };
}

function comparisonText(item, equippedBySlot) {
  const equipped = equippedBySlot[item.slot];
  if (!equipped || equipped.inventory_id === item.inventory_id) return '';
  const itemStats = effectiveStats(item);
  const eqStats = effectiveStats(equipped);
  const diffAtk = itemStats.atk - eqStats.atk;
  const diffHp = itemStats.hp - eqStats.hp;
  if (diffAtk === 0 && diffHp === 0) return '<div class="item-compare neutral">vs equipped: no change</div>';
  const parts = [];
  if (diffAtk !== 0) parts.push(`${diffAtk > 0 ? '+' : ''}${diffAtk} ATK`);
  if (diffHp !== 0) parts.push(`${diffHp > 0 ? '+' : ''}${diffHp} HP`);
  const overallBetter = (diffAtk + diffHp) >= 0;
  return `<div class="item-compare ${overallBetter ? 'better' : 'worse'}">vs equipped: ${parts.join(' / ')}</div>`;
}

function renderInventoryGrid() {
  const grid = document.getElementById('inventory-grid');
  grid.innerHTML = '';

  const equippedBySlot = {};
  inventoryItemsCache.forEach(item => {
    if (item.equipped) equippedBySlot[item.slot] = item;
  });

  let items = activeInventorySlot === 'all'
    ? inventoryItemsCache
    : inventoryItemsCache.filter(i => i.slot === activeInventorySlot);

  items = [...items].sort((a, b) => {
    if (activeInventorySort === 'rarity') return RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity);
    if (activeInventorySort === 'level') return b.required_level - a.required_level;
    if (activeInventorySort === 'name') return a.name.localeCompare(b.name);
    return a.slot.localeCompare(b.slot); // default: slot
  });

  if (items.length === 0) {
    grid.innerHTML = '<p class="empty-msg">Nothing here. Visit the Black Market or change the filter above.</p>';
    return;
  }

  items.forEach(item => {
    const row = document.createElement('div');
    row.className = `item-row rarity-border-${item.rarity}`;
    if (item.is_quest_item) {
      row.innerHTML = `
        <div class="row-with-icon">
          <img class="row-icon" src="/images/items/${item.image}.svg" alt="" />
          <div>
            <span class="name">${item.name}</span> <span class="item-meta">(Quest Item)</span>
          </div>
        </div>
        <button class="btn-ghost btn-sell">Discard</button>
      `;
      row.querySelector('.btn-sell').addEventListener('click', () => sellItem(item));
    } else {
      const refund = Math.floor(item.price * 0.5);
      const upgradeBadge = item.upgrade_level > 0 ? `<span class="upgrade-badge">+${item.upgrade_level}</span>` : '';
      row.innerHTML = `
        <div class="row-with-icon">
          <img class="row-icon" src="/images/items/${item.image}.svg" alt="" />
          <div>
            <span class="name rarity-${item.rarity}">${item.name}</span>${upgradeBadge} <span class="item-meta">(${item.slot}, req. Lv.${item.required_level})</span>
            ${item.equipped ? '<span class="tag-equipped">Equipped</span>' : ''}
            <div class="item-bonus">${bonusText(item)}</div>
            ${setTagHtml(item)}
            ${comparisonText(item, equippedBySlot)}
          </div>
        </div>
        <div class="item-actions">
          <button class="btn-protect ${item.protected ? 'active' : ''}" title="Protect from bulk salvage">&#9733;</button>
          <button class="btn-ghost btn-equip">${item.equipped ? 'Unequip' : 'Equip'}</button>
          <button class="btn-ghost btn-upgrade">Upgrade</button>
          <button class="btn-ghost btn-sell">Sell (${refund}g)</button>
          ${item.equipped ? '' : '<button class="btn-ghost btn-list-market">List on Market</button>'}
        </div>
      `;
      row.querySelector('.btn-equip').addEventListener('click', async () => {
        try {
          const endpoint = item.equipped ? '/inventory/unequip' : '/inventory/equip';
          const data2 = await api(endpoint, { method: 'POST', body: JSON.stringify({ inventoryId: item.inventory_id }) });
          state.character = data2.character;
          updateTopBar();
          applyTutorialStep(data2.character.tutorial_step);
          loadInventory();
        } catch (err) {
          showToast(err.message, true);
        }
      });
      row.querySelector('.btn-sell').addEventListener('click', () => sellItem(item));
      row.querySelector('.btn-upgrade').addEventListener('click', () => upgradeItem(item));
      row.querySelector('.btn-protect').addEventListener('click', async () => {
        try {
          await api('/inventory/protect', { method: 'POST', body: JSON.stringify({ inventoryId: item.inventory_id }) });
          loadInventory();
        } catch (err) {
          showToast(err.message, true);
        }
      });
      const listBtn = row.querySelector('.btn-list-market');
      if (listBtn) {
        listBtn.addEventListener('click', async () => {
          const price = window.prompt(`List "${item.name}"${item.upgrade_level > 0 ? ` +${item.upgrade_level}` : ''} for how much gold?`);
          if (!price) return;
          const priceNum = parseInt(price, 10);
          if (!priceNum || priceNum < 1) {
            showToast('Enter a valid price.', true);
            return;
          }
          try {
            await api('/marketplace/list-equipment', { method: 'POST', body: JSON.stringify({ inventoryId: item.inventory_id, price: priceNum }) });
            showToast(`Listed ${item.name} for ${priceNum} gold.`);
            loadInventory();
          } catch (err) {
            showToast(err.message, true);
          }
        });
      }
    }
    grid.appendChild(row);
  });
}

document.querySelectorAll('#inventory-subtabs .shop-subtab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#inventory-subtabs .shop-subtab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeInventorySlot = btn.dataset.slot;
    renderInventoryGrid();
  });
});

document.getElementById('inventory-sort').addEventListener('change', (e) => {
  activeInventorySort = e.target.value;
  renderInventoryGrid();
});

document.getElementById('sell-all-common-btn').addEventListener('click', async () => {
  if (!window.confirm('Sell every unequipped, unprotected Common item for 50% of its shop price?')) return;
  try {
    const data = await api('/inventory/sell-all-common', { method: 'POST' });
    state.character = data.character;
    updateTopBar();
    showToast(data.itemsSold > 0 ? `Sold ${data.itemsSold} items for ${data.totalRefund} gold.` : 'Nothing to sell.');
    loadInventory();
  } catch (err) {
    showToast(err.message, true);
  }
});

function bonusText(item) {
  const stats = effectiveStats(item);
  const parts = [];
  if (stats.atk) parts.push(`+${stats.atk} ATK`);
  if (stats.hp) parts.push(`+${stats.hp} HP`);
  return parts.join(' / ');
}

function setTagHtml(item) {
  return item.set_name ? `<div class="item-set-tag">Set: ${item.set_name}</div>` : '';
}

function ownedTagHtml(count) {
  return count > 0 ? `<span class="owned-tag">Owned: ${count}</span>` : '';
}

// Approximate cost/risk shown before an upgrade attempt (mirrors server-side formulas
// in gameLogic.js - kept in sync manually since this is just a heads-up display).
const UPGRADE_SUCCESS_CHANCE_DISPLAY = { 1: 90, 2: 75, 3: 60, 4: 45, 5: 30 };
const UPGRADE_RISK_DISPLAY = { 1: 'safe', 2: 'safe', 3: 'risky - can be destroyed', 4: 'risky - can be destroyed', 5: 'risky - can be destroyed' };

async function upgradeItem(item) {
  const targetLevel = (item.upgrade_level || 0) + 1;
  if (targetLevel > 5) {
    showToast(`${item.name} is already at maximum upgrade level.`, true);
    return;
  }
  const cost = 50 * targetLevel * targetLevel;
  const chance = UPGRADE_SUCCESS_CHANCE_DISPLAY[targetLevel];
  const risk = UPGRADE_RISK_DISPLAY[targetLevel];
  const confirmMsg = `Upgrade ${item.name} to +${targetLevel}?\n\nCost: ${cost} gold\nSuccess chance: ${chance}%\nRisk: ${risk}\n\nGold is spent whether it succeeds or not.`;
  if (!window.confirm(confirmMsg)) return;

  try {
    const data = await api('/inventory/upgrade', { method: 'POST', body: JSON.stringify({ inventoryId: item.inventory_id }) });
    state.character = data.character;
    updateTopBar();
    if (data.outcome === 'success') {
      showToast(`${data.itemName} upgraded to +${data.newLevel}!`);
    } else if (data.outcome === 'fail_destroyed') {
      showToast(`${data.itemName} was destroyed in the attempt!`, true);
    } else {
      showToast(`Upgrade failed. ${data.itemName} is unchanged.`, true);
    }
    loadInventory();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function sellItem(item) {
  const refund = Math.floor(item.price * 0.5);
  const confirmMsg = refund > 0
    ? `Sell ${item.name} for ${refund} gold?`
    : `Discard ${item.name}? This can't be undone.`;
  if (!window.confirm(confirmMsg)) return;
  try {
    const data = await api('/inventory/sell', { method: 'POST', body: JSON.stringify({ inventoryId: item.inventory_id }) });
    state.character = data.character;
    updateTopBar();
    showToast(data.refund > 0 ? `Sold ${data.itemName} for ${data.refund} gold.` : `Discarded ${data.itemName}.`);
    loadInventory();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---------- Shop ----------
let shopItemsCache = [];
let potionsCache = [];
let activeShopSlot = 'all';

async function loadShop() {
  const data = await api('/inventory/shop');
  shopItemsCache = data.items;
  try {
    const potionData = await api('/inventory/potions');
    potionsCache = potionData.potions;
  } catch {
    // Potions tab just won't populate if this fails - rest of the shop still works.
  }
  if (inventoryItemsCache.length === 0) {
    // Shop may be opened before Inventory ever is - make sure we have equipped-item
    // data available so comparisons can render.
    try {
      const invData = await api('/inventory');
      inventoryItemsCache = invData.items;
    } catch {
      // fine to proceed without comparisons if this fails for some reason
    }
  }
  renderShopGrid();
}

function renderShopGrid() {
  if (activeShopSlot === 'potions') {
    renderPotionsGrid();
    return;
  }
  const grid = document.getElementById('shop-grid');
  grid.innerHTML = '';
  const items = activeShopSlot === 'all'
    ? shopItemsCache
    : shopItemsCache.filter(i => i.slot === activeShopSlot);

  const equippedBySlot = {};
  inventoryItemsCache.forEach(i => {
    if (i.equipped) equippedBySlot[i.slot] = i;
  });

  if (items.length === 0) {
    grid.innerHTML = '<p class="empty-msg">Nothing in this category yet.</p>';
    return;
  }

  items.forEach(item => {
    const row = document.createElement('div');
    row.className = `item-row rarity-border-${item.rarity}`;
    row.innerHTML = `
      <div class="row-with-icon">
        <img class="row-icon" src="/images/items/${item.image}.svg" alt="" />
        <div>
          <span class="name rarity-${item.rarity}">${item.name}</span> <span class="item-meta">(${item.slot}, req. Lv.${item.required_level})</span> ${ownedTagHtml(item.owned_count)}
          <div class="item-bonus">${bonusText(item)}</div>
          ${setTagHtml(item)}
          ${comparisonText(item, equippedBySlot)}
        </div>
      </div>
      <button class="btn-attack">${item.price} Gold</button>
    `;
    row.querySelector('button').addEventListener('click', async () => {
      try {
        const data2 = await api('/inventory/buy', { method: 'POST', body: JSON.stringify({ itemTemplateId: item.id }) });
        state.character = data2.character;
        updateTopBar();
        showToast(`Bought ${item.name}!`);
      } catch (err) {
        showToast(err.message, true);
      }
    });
    grid.appendChild(row);
  });
}

function renderPotionsGrid() {
  const grid = document.getElementById('shop-grid');
  grid.innerHTML = '';
  potionsCache.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <div class="row-with-icon">
        <img class="row-icon" src="/images/potions/${p.image}.svg" alt="" />
        <div>
          <span class="name">${p.name}</span>
          <div class="item-bonus">${p.description}</div>
        </div>
      </div>
      <button class="btn-attack">${p.price.toLocaleString()} Gold</button>
    `;
    row.querySelector('button').addEventListener('click', async () => {
      if (!window.confirm(`Buy ${p.name} for ${p.price.toLocaleString()} gold? It activates immediately.`)) return;
      try {
        const data = await api('/inventory/buy-potion', { method: 'POST', body: JSON.stringify({ potionType: p.potionType }) });
        state.character = data.character;
        updateTopBar();
        showToast(`${p.name} activated!`);
      } catch (err) {
        showToast(err.message, true);
      }
    });
    grid.appendChild(row);
  });
}

document.querySelectorAll('.shop-subtab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.shop-subtab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeShopSlot = btn.dataset.slot;
    renderShopGrid();
  });
});

// ---------- Clans ----------
async function setClanRole(characterId, role) {
  try {
    await api('/clans/set-role', { method: 'POST', body: JSON.stringify({ characterId: parseInt(characterId, 10), role }) });
    showToast(`Role updated.`);
    loadClanPanel();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function kickClanMember(characterId) {
  if (!window.confirm('Remove this member from the clan?')) return;
  try {
    await api('/clans/kick', { method: 'POST', body: JSON.stringify({ characterId: parseInt(characterId, 10) }) });
    showToast('Member removed.');
    loadClanPanel();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function assignVaultItem(vaultItemId, itemName, members) {
  const memberNames = members.map((m) => m.name).join(', ');
  const targetName = window.prompt(`Assign "${itemName}" to which member? (${memberNames})`);
  const target = members.find((m) => m.name.toLowerCase() === (targetName || '').toLowerCase());
  if (!target) { showToast('Member not found.', true); return; }
  try {
    await api('/clans/vault/assign-item', { method: 'POST', body: JSON.stringify({ vaultItemId: parseInt(vaultItemId, 10), targetCharacterId: target.id }) });
    showToast(`Assigned "${itemName}" to ${target.name}.`);
    loadClanPanel();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function loadClanPanel() {
  const content = document.getElementById('clan-content');
  const meData = await api('/auth/me');
  const c = meData.character;

  if (c.clan_id) {
    const [infoData, roster, vault] = await Promise.all([
      api(`/clans/${c.clan_id}/info`),
      api(`/clans/${c.clan_id}/roster`),
      api('/clans/vault').catch(() => ({ items: [], vaultGold: 0 })),
    ]);
    const clan = infoData.clan;
    const canManage = c.clan_role === 'leader' || c.clan_role === 'officer';
    const pct = Math.round((clan.clan_xp / clan.expToNextLevel) * 100);

    content.innerHTML = `
      <div class="bonus-breakdown-box">
        <h3 class="subheading">${clan.name} - Level ${clan.clan_level}</h3>
        <div class="bar" style="height:10px;"><div class="bar-fill" style="width:${pct}%"></div></div>
        <p class="hint" style="margin-top:8px;">${clan.clan_xp.toLocaleString()}/${clan.expToNextLevel.toLocaleString()} XP &nbsp;|&nbsp; ${clan.memberCount}/${clan.memberCap} members &nbsp;|&nbsp; Perk: +${clan.perkPercent}% ATK/HP/Gold to every member</p>
      </div>

      <h3 class="subheading">Roster</h3>
      <div id="roster"></div>

      <h3 class="subheading">Vault</h3>
      <div class="bonus-breakdown-box">
        <div class="bonus-row">
          <span class="bonus-source">Gold in vault</span>
          <span class="bonus-values">${vault.vaultGold.toLocaleString()}</span>
        </div>
      </div>
      <div style="margin:10px 0; display:flex; gap:8px;">
        <button class="btn-ghost" id="deposit-gold-btn">Deposit Gold</button>
        ${canManage ? '<button class="btn-ghost" id="assign-gold-btn">Assign Gold to Member</button>' : ''}
        <button class="btn-ghost" id="deposit-item-btn">Deposit Item</button>
      </div>
      <div id="vault-items"></div>

      <button class="btn-ghost" id="leave-clan-btn" style="margin-top:16px;">Leave Clan</button>
    `;

    const rosterEl = document.getElementById('roster');
    roster.members.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'clan-row';
      const roleTag = m.clan_role === 'leader' ? ' (Leader)' : m.clan_role === 'officer' ? ' (Officer)' : '';
      let actions = '';
      if (c.clan_role === 'leader' && m.id !== c.id) {
        actions += m.clan_role === 'officer'
          ? `<button class="btn-ghost btn-demote" data-id="${m.id}">Demote</button>`
          : `<button class="btn-ghost btn-promote" data-id="${m.id}">Promote</button>`;
      }
      if (canManage && m.id !== c.id && !(c.clan_role === 'officer' && m.clan_role !== 'member')) {
        actions += `<button class="btn-ghost btn-kick" data-id="${m.id}">Kick</button>`;
      }
      row.innerHTML = `<span>${m.name}${roleTag} - Lv.${m.level}</span><span>${actions}</span>`;
      rosterEl.appendChild(row);
    });
    rosterEl.querySelectorAll('.btn-promote').forEach((btn) => btn.addEventListener('click', () => setClanRole(btn.dataset.id, 'officer')));
    rosterEl.querySelectorAll('.btn-demote').forEach((btn) => btn.addEventListener('click', () => setClanRole(btn.dataset.id, 'member')));
    rosterEl.querySelectorAll('.btn-kick').forEach((btn) => btn.addEventListener('click', () => kickClanMember(btn.dataset.id)));

    const vaultItemsEl = document.getElementById('vault-items');
    if (vault.items.length === 0) {
      vaultItemsEl.innerHTML = '<p class="empty-msg">No items in the vault.</p>';
    } else {
      vaultItemsEl.innerHTML = '';
      vault.items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'market-row';
        const statParts = [];
        if (item.bonus_atk) statParts.push(`+${item.bonus_atk} ATK`);
        if (item.bonus_hp) statParts.push(`+${item.bonus_hp} HP`);
        row.innerHTML = `
          <div class="row-with-icon">
            <img class="row-icon" src="/images/items/${item.image}.svg" alt="" />
            <div>
              <span class="name rarity-${item.rarity}">${item.name}${item.upgrade_level > 0 ? ` +${item.upgrade_level}` : ''}</span>
              <div class="item-bonus">${statParts.join(' / ')}</div>
              <div class="market-seller">Donated by ${item.donated_by_name}</div>
            </div>
          </div>
          ${canManage ? `<button class="btn-primary btn-assign-item" data-id="${item.id}" data-name="${item.name}">Assign</button>` : ''}
        `;
        vaultItemsEl.appendChild(row);
      });
      vaultItemsEl.querySelectorAll('.btn-assign-item').forEach((btn) => {
        btn.addEventListener('click', () => assignVaultItem(btn.dataset.id, btn.dataset.name, roster.members));
      });
    }

    document.getElementById('deposit-gold-btn').addEventListener('click', async () => {
      const amount = window.prompt('How much gold to deposit into the vault?');
      if (!amount) return;
      try {
        await api('/clans/vault/deposit-gold', { method: 'POST', body: JSON.stringify({ amount: parseInt(amount, 10) }) });
        showToast('Gold deposited.');
        loadClanPanel();
      } catch (err) {
        showToast(err.message, true);
      }
    });

    if (canManage) {
      document.getElementById('assign-gold-btn').addEventListener('click', async () => {
        const memberNames = roster.members.map((m) => m.name).join(', ');
        const targetName = window.prompt(`Assign gold to which member? (${memberNames})`);
        const target = roster.members.find((m) => m.name.toLowerCase() === (targetName || '').toLowerCase());
        if (!target) { showToast('Member not found.', true); return; }
        const amount = window.prompt(`How much gold to assign to ${target.name}?`);
        if (!amount) return;
        try {
          await api('/clans/vault/assign-gold', { method: 'POST', body: JSON.stringify({ amount: parseInt(amount, 10), targetCharacterId: target.id }) });
          showToast(`Assigned gold to ${target.name}.`);
          loadClanPanel();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }

    document.getElementById('deposit-item-btn').addEventListener('click', async () => {
      try {
        const invData = await api('/inventory');
        const unequipped = invData.items.filter((i) => !i.equipped);
        if (unequipped.length === 0) { showToast('No unequipped items to deposit.', true); return; }
        const itemNames = unequipped.map((i) => `${i.inventory_id}:${i.name}`).join(', ');
        const chosen = window.prompt(`Deposit which item? Enter its inventory ID.\n(${itemNames})`);
        if (!chosen) return;
        await api('/clans/vault/deposit-item', { method: 'POST', body: JSON.stringify({ inventoryId: parseInt(chosen, 10) }) });
        showToast('Item deposited into the vault.');
        loadClanPanel();
      } catch (err) {
        showToast(err.message, true);
      }
    });

    document.getElementById('leave-clan-btn').addEventListener('click', async () => {
      try {
        const data = await api('/clans/leave', { method: 'POST' });
        state.character = data.character;
        if (socket) socket.emit('clan_changed');
        loadClanPanel();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  } else {
    const clansData = await api('/clans');
    content.innerHTML = `
      <form class="clan-form" id="create-clan-form">
        <input type="text" id="new-clan-name" placeholder="Found a new clan..." />
        <button class="btn-primary" type="submit">Create</button>
      </form>
      <div id="clan-list"></div>
    `;
    const list = document.getElementById('clan-list');
    if (clansData.clans.length === 0) {
      list.innerHTML = '<p class="empty-msg">No clans exist yet. Be the first.</p>';
    }
    clansData.clans.forEach(clan => {
      const row = document.createElement('div');
      row.className = 'clan-row';
      row.innerHTML = `<span>${clan.name} (${clan.member_count} members)</span><button class="btn-ghost">Join</button>`;
      row.querySelector('button').addEventListener('click', async () => {
        try {
          const data = await api('/clans/join', { method: 'POST', body: JSON.stringify({ clanId: clan.id }) });
          state.character = data.character;
          if (socket) socket.emit('clan_changed');
          loadClanPanel();
        } catch (err) {
          showToast(err.message, true);
        }
      });
      list.appendChild(row);
    });
    document.getElementById('create-clan-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('new-clan-name').value.trim();
      try {
        const data = await api('/clans/create', { method: 'POST', body: JSON.stringify({ name }) });
        state.character = data.character;
        if (socket) socket.emit('clan_changed');
        loadClanPanel();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }
}

// ---------- Leaderboard ----------
async function loadLeaderboard() {
  const data = await api('/leaderboard');
  const tbody = document.querySelector('#leaderboard-table tbody');
  tbody.innerHTML = '';
  data.rankings.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i + 1}</td><td class="player-link">${r.name}</td><td>${r.level}</td><td>${r.rebirth_count || 0}</td><td>${r.exp}</td><td>${r.clan_name || '-'}</td>`;
    tr.querySelector('.player-link').addEventListener('click', () => showProfileModal(r.name));
    tbody.appendChild(tr);
  });
}

// ---------- Quests ----------
function questObjectiveText(q) {
  if (q.type === 'kill') return `Kill ${q.required_count}x ${q.monster_name}`;
  return `Collect ${q.required_count}x ${q.item_name}`;
}

function questLocationText(q) {
  if (!q.locations || q.locations.length === 0) return '';
  const label = q.type === 'collect' ? 'Dropped by' : 'Found in';
  const parts = q.locations.map(l =>
    q.type === 'collect' ? `${l.monster_name} — ${l.room_name} (${l.zone_name})` : `${l.room_name} (${l.zone_name})`
  );
  return `<div class="quest-location">&#128205; ${label}: ${parts.join('; ')}</div>`;
}

function questRewardText(q) {
  const parts = [];
  if (q.reward_exp) parts.push(`${q.reward_exp} EXP`);
  if (q.reward_gold) parts.push(`${q.reward_gold} Gold`);
  return parts.join(', ');
}

function questRewardItemHtml(q) {
  if (!q.rewardItem) return '';
  const stats = effectiveStats(q.rewardItem);
  const parts = [];
  if (stats.atk) parts.push(`+${stats.atk} ATK`);
  if (stats.hp) parts.push(`+${stats.hp} HP`);
  return `
    <div class="quest-reward-item">
      <img class="row-icon" src="/images/items/${q.rewardItem.image}.svg" alt="" />
      <div>
        <span class="name rarity-${q.rewardItem.rarity}">${q.rewardItem.name}</span>
        <span class="item-meta">(${q.rewardItem.slot})</span>
        <div class="item-bonus">${parts.join(' / ')}</div>
        ${q.rewardItem.set_name ? `<div class="item-set-tag">Set: ${q.rewardItem.set_name}</div>` : ''}
      </div>
    </div>
  `;
}

async function loadQuestTracker() {
  const [activeData, availableData] = await Promise.all([
    api('/quests/active'),
    api('/quests/available'),
  ]);

  const activeList = document.getElementById('world-active-quest-list');
  activeList.innerHTML = '';
  const activeOnly = activeData.quests.filter(q => q.status === 'active');
  if (activeOnly.length === 0) {
    activeList.innerHTML = '<p class="empty-msg">No active quests. Check the Available tab to accept one.</p>';
  }
  activeOnly.forEach(q => {
    const pct = Math.min(100, (q.progress_count / q.required_count) * 100);
    const row = document.createElement('div');
    row.className = 'quest-row';
    row.innerHTML = `
      <div class="quest-name">${q.name}${q.generation > 0 ? ` <span class="item-meta">(Gen ${q.generation})</span>` : ''}</div>
      <div class="quest-desc">${q.description || ''}</div>
      <div class="quest-progress">${questObjectiveText(q)} — ${q.progress_count}/${q.required_count}</div>
      <div class="quest-progress-bar"><div class="fill" style="width:${pct}%"></div></div>
      ${questLocationText(q)}
      <div class="quest-reward">Reward: ${questRewardText(q)}</div>
      ${questRewardItemHtml(q)}
    `;
    activeList.appendChild(row);
  });

  const availableList = document.getElementById('world-available-quest-list');
  availableList.innerHTML = '';
  if (availableData.quests.length === 0) {
    availableList.innerHTML = '<p class="empty-msg">No new quests available right now.</p>';
  }
  availableData.quests.forEach(q => {
    const row = document.createElement('div');
    row.className = 'quest-row' + (q.locked ? ' quest-locked' : '');
    row.innerHTML = `
      <div class="quest-name">${q.name}${q.generation > 0 ? ` <span class="item-meta">(Gen ${q.generation})</span>` : ''} <span class="item-meta">(req. Lv.${q.min_level})</span></div>
      <div class="quest-desc">${q.description || ''}</div>
      <div class="quest-progress">${questObjectiveText(q)}</div>
      ${questLocationText(q)}
      ${q.locked ? `<div class="quest-lock-reason">&#128274; ${q.lockReason}</div>` : ''}
      <div class="quest-footer">
        <div class="quest-reward">Reward: ${questRewardText(q)}</div>
        <button class="btn-primary" ${q.locked ? 'disabled' : ''}>${q.locked ? 'Locked' : 'Accept'}</button>
      </div>
      ${questRewardItemHtml(q)}
    `;
    if (!q.locked) {
      row.querySelector('button').addEventListener('click', async () => {
        try {
          const acceptData = await api('/quests/accept', { method: 'POST', body: JSON.stringify({ questTemplateId: q.id }) });
          showToast(`Accepted: ${q.name}`);
          applyTutorialStep(acceptData.tutorialStep);
          loadQuestTracker();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }
    availableList.appendChild(row);
  });
}

document.querySelectorAll('.quest-subtab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.quest-subtab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('world-active-quest-list').classList.toggle('hidden', btn.dataset.questview !== 'active');
    document.getElementById('world-available-quest-list').classList.toggle('hidden', btn.dataset.questview !== 'available');
  });
});

// ---------- Travel ----------
async function loadTravel() {
  const data = await api('/world/zones');
  const grid = document.getElementById('travel-grid');
  grid.innerHTML = '';
  data.zones.forEach(zone => {
    const card = document.createElement('div');
    card.className = 'travel-card' + (zone.locked ? ' locked' : '');
    card.innerHTML = `
      ${zone.is_dungeon ? '<span class="dungeon-tag">Dungeon</span><br/>' : ''}
      <div class="zone-title">${zone.name}</div>
      <div class="zone-desc">${zone.description || ''}</div>
      <button class="btn-primary" ${zone.locked ? 'disabled' : ''}>${zone.locked ? `Requires Lv.${zone.min_level}` : 'Travel'}</button>
    `;
    if (!zone.locked) {
      card.querySelector('button').addEventListener('click', async () => {
        try {
          const roomData = await api('/world/teleport', { method: 'POST', body: JSON.stringify({ zoneId: zone.id }) });
          state.currentRoomDetails = roomData;
          renderRoom(roomData);
          if (socket) socket.emit('room_changed');
          document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
          document.querySelector('[data-panel="panel-world"]').classList.add('active');
          document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
          document.getElementById('panel-world').classList.remove('hidden');
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }
    grid.appendChild(card);
  });
}

// ---------- Real-time: presence + chat ----------
let socket = null;

function connectSocket() {
  if (socket) return; // already connected (e.g. re-entering game after character creation)
  socket = io();

  socket.on('presence_update', ({ roomId, players }) => {
    // Only matters if it's the room we're currently standing in.
    if (!state.currentRoomDetails || state.currentRoomDetails.room.id !== roomId) return;
    const others = players.filter(p => p.id !== state.character.id);
    state.currentRoomDetails.otherPlayers = others;
    const playersEl = document.getElementById('room-players');
    if (playersEl) renderRoomPlayersList(playersEl, others);
  });

  // Lets everyone in the room see the boss's HP tick down live, not just whoever's attacking.
  socket.on('world_boss_update', ({ worldBossId, currentHp, maxHp, lastHitBy, lastHitDamage, topContributors }) => {
    if (worldBossId !== currentWorldBossId) return;
    updateWorldBossBar(currentHp, maxHp);
    renderWorldBossContributors(topContributors);
    if (lastHitBy && lastHitBy !== state.character.name) {
      document.getElementById('worldboss-status').textContent = `${lastHitBy} hit it for ${lastHitDamage}.`;
    }
  });

  socket.on('world_boss_defeated', ({ worldBossId, name, contributors }) => {
    if (worldBossId !== currentWorldBossId) return;
    document.getElementById('worldboss-status').textContent = 'Defeated - will return later.';
    const attackBtn = document.getElementById('worldboss-attack-btn');
    attackBtn.disabled = true;
    attackBtn.textContent = 'Defeated';
    updateWorldBossBar(0, 1);
    renderWorldBossKillModal({ bossName: name, contributors });
  });

  socket.on('chat_history', ({ channel, messages }) => {
    const logEl = chatLogElementForChannel(channel);
    if (!logEl) return;
    logEl.innerHTML = '';
    messages.forEach(m => appendChatMessage(logEl, m.character_name, m.text));
  });

  socket.on('chat_message', ({ channel, characterName, text }) => {
    const logEl = chatLogElementForChannel(channel);
    if (!logEl) return;
    appendChatMessage(logEl, characterName, text);
  });
}

// Maps a server channel name ('global' or 'clan:<id>') to the right chat log element.
function chatLogElementForChannel(channel) {
  if (channel === 'global') return document.getElementById('chat-log-global');
  if (channel.startsWith('clan:')) return document.getElementById('chat-log-clan');
  return null;
}

function appendChatMessage(logEl, who, text) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const safeWho = who.replace(/</g, '&lt;');
  const safeText = text.replace(/</g, '&lt;');
  div.innerHTML = `<span class="who player-link">${safeWho}:</span> ${safeText}`;
  div.querySelector('.who').addEventListener('click', () => showProfileModal(who));
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

document.querySelectorAll('.chat-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.chat-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('chat-log-global').classList.toggle('hidden', tab.dataset.channel !== 'global');
    document.getElementById('chat-log-clan').classList.toggle('hidden', tab.dataset.channel !== 'clan');
  });
});

document.getElementById('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !socket) return;
  const activeTab = document.querySelector('.chat-tab.active');
  const channel = activeTab ? activeTab.dataset.channel : 'global';
  if (channel === 'clan' && !state.character.clan_id) {
    showToast('Join a clan to use clan chat.', true);
    return;
  }
  socket.emit('chat_message', { channel, text });
  input.value = '';
});

document.getElementById('chat-collapse-btn').addEventListener('click', () => {
  document.getElementById('chat-widget').classList.add('hidden');
  document.getElementById('chat-reopen-btn').classList.remove('hidden');
});
document.getElementById('chat-reopen-btn').addEventListener('click', () => {
  document.getElementById('chat-widget').classList.remove('hidden');
  document.getElementById('chat-reopen-btn').classList.add('hidden');
});

// Show the chat widget once we're actually in the game (not on the login screen).
function showChatWidget() {
  document.getElementById('chat-widget').classList.remove('hidden');
}

// ---------- Admin ----------
async function loadAdminPanel() {
  await Promise.all([loadAdminStats(), loadAdminPlayers()]);
}

async function loadAdminStats() {
  try {
    const s = await api('/admin/stats');
    const el = document.getElementById('admin-stats');
    el.innerHTML = `
      <div class="stat-box"><div class="label">Total Accounts</div><div class="value">${s.totalUsers}</div></div>
      <div class="stat-box"><div class="label">Characters</div><div class="value">${s.totalCharacters}</div></div>
      <div class="stat-box"><div class="label">Banned</div><div class="value">${s.bannedCount}</div></div>
      <div class="stat-box"><div class="label">Avg Level</div><div class="value">${s.avgLevel}</div></div>
      <div class="stat-box"><div class="label">Max Level</div><div class="value">${s.maxLevel}</div></div>
      <div class="stat-box"><div class="label">Total Gold</div><div class="value">${s.totalGold.toLocaleString()}</div></div>
    `;
    if (s.worldBosses && s.worldBosses.length) {
      const bossBox = document.createElement('div');
      bossBox.className = 'stat-box';
      bossBox.style.gridColumn = '1 / -1';
      bossBox.innerHTML = `<div class="label">World Bosses</div><div class="value" style="font-size:14px;">` +
        s.worldBosses.map(b => `${b.name}: ${b.is_alive ? `${b.current_hp}/${b.max_hp} HP` : 'defeated, respawning'}`).join(' | ') +
        `</div>`;
      el.appendChild(bossBox);
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

async function loadAdminPlayers(search) {
  try {
    const query = search ? `?search=${encodeURIComponent(search)}` : '';
    const data = await api(`/admin/players${query}`);
    const list = document.getElementById('admin-player-list');
    list.innerHTML = '';
    if (data.players.length === 0) {
      list.innerHTML = '<p class="empty-msg">No players found.</p>';
      return;
    }
    data.players.forEach(p => {
      const row = document.createElement('div');
      row.className = 'admin-player-row' + (p.banned ? ' banned' : '');
      row.innerHTML = `
        <div class="admin-player-info">
          <span class="apn">${p.username}${p.is_admin ? '<span class="admin-tag admin">Admin</span>' : ''}${p.banned ? '<span class="admin-tag banned">Banned</span>' : ''}</span>
          <span class="apm">${p.character_name ? `${p.character_name} — Lv.${p.level}, ${p.gold}g` : 'No character yet'} — joined ${p.account_created_at}</span>
        </div>
        <div class="admin-player-actions">
          ${p.is_admin ? '' : `<button class="btn-ghost admin-ban-btn">${p.banned ? 'Unban' : 'Ban'}</button>
          <button class="btn-danger admin-delete-btn">Delete</button>`}
        </div>
      `;
      if (!p.is_admin) {
        row.querySelector('.admin-ban-btn').addEventListener('click', async () => {
          const action = p.banned ? 'unban' : 'ban';
          if (!window.confirm(`${action === 'ban' ? 'Ban' : 'Unban'} ${p.username}?`)) return;
          try {
            await api(`/admin/players/${p.user_id}/${action}`, { method: 'POST' });
            showToast(`${p.username} ${action === 'ban' ? 'banned' : 'unbanned'}.`);
            loadAdminPlayers(document.getElementById('admin-search-input').value.trim());
          } catch (err) {
            showToast(err.message, true);
          }
        });
        row.querySelector('.admin-delete-btn').addEventListener('click', async () => {
          if (!window.confirm(`Permanently delete ${p.username}'s account and character? This cannot be undone.`)) return;
          try {
            await api(`/admin/players/${p.user_id}`, { method: 'DELETE' });
            showToast(`Deleted ${p.username}.`);
            loadAdminPlayers(document.getElementById('admin-search-input').value.trim());
          } catch (err) {
            showToast(err.message, true);
          }
        });
      }
      list.appendChild(row);
    });
  } catch (err) {
    showToast(err.message, true);
  }
}

document.getElementById('admin-search-btn').addEventListener('click', () => {
  loadAdminPlayers(document.getElementById('admin-search-input').value.trim());
});
document.getElementById('admin-search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    loadAdminPlayers(document.getElementById('admin-search-input').value.trim());
  }
});

// ---------- News ----------
async function loadNewsFeed() {
  try {
    const data = await api('/news');
    renderNewsFeed(data.posts);

    // Mark as read and clear the badge - only matters the first time this loads per session,
    // but harmless to call every time the tab is opened.
    await api('/news/mark-read', { method: 'POST' });
    document.getElementById('news-badge').classList.add('hidden');

    const form = document.getElementById('news-post-form');
    form.classList.toggle('hidden', !(state.user && state.user.is_admin));
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderNewsFeed(posts) {
  const feed = document.getElementById('news-feed');
  feed.innerHTML = '';
  if (posts.length === 0) {
    feed.innerHTML = '<p class="empty-msg">Nothing posted yet.</p>';
    return;
  }
  const isAdmin = state.user && state.user.is_admin;
  posts.forEach(post => {
    const card = document.createElement('div');
    card.className = `news-post-card category-${post.category}`;
    card.innerHTML = `
      <div class="news-post-header">
        <div>
          <span class="news-category-tag category-${post.category}">${post.category}</span>
          <span class="news-post-title">${post.title}</span>
        </div>
        ${isAdmin ? '<button class="btn-danger news-delete-btn">Delete</button>' : ''}
      </div>
      <div class="news-post-meta">Posted by ${post.author_username} — ${timeAgo(post.created_at)}</div>
      <div class="news-post-body">${post.body}</div>
    `;
    if (isAdmin) {
      card.querySelector('.news-delete-btn').addEventListener('click', async () => {
        if (!window.confirm(`Delete "${post.title}"?`)) return;
        try {
          await api(`/news/${post.id}`, { method: 'DELETE' });
          showToast('Post deleted.');
          loadNewsFeed();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }
    feed.appendChild(card);
  });
}

document.getElementById('news-post-btn').addEventListener('click', async () => {
  const title = document.getElementById('news-title-input').value.trim();
  const body = document.getElementById('news-body-input').value.trim();
  const category = document.getElementById('news-category-input').value;
  if (!title || !body) {
    showToast('Title and body are both required.', true);
    return;
  }
  try {
    await api('/news', { method: 'POST', body: JSON.stringify({ title, body, category }) });
    document.getElementById('news-title-input').value = '';
    document.getElementById('news-body-input').value = '';
    showToast('Posted!');
    loadNewsFeed();
  } catch (err) {
    showToast(err.message, true);
  }
});

// ---------- Tower of Ascension ----------
async function loadTowerPanel() {
  try {
    const status = await api('/tower/status');
    renderTowerStatus(status);
  } catch (err) {
    showToast(err.message, true);
  }

  try {
    const data = await api('/tower/leaderboard');
    const tbody = document.querySelector('#tower-leaderboard-table tbody');
    tbody.innerHTML = '';
    data.rankings.forEach((r, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td class="player-link">${r.name}</td><td>${r.tower_level}</td>`;
      tr.querySelector('.player-link').addEventListener('click', () => showProfileModal(r.name));
      tbody.appendChild(tr);
    });
  } catch (err) {
    // Non-critical - the main Tower status above still works even if this fails.
  }
}

function renderTowerStatus(status) {
  document.getElementById('tower-floor-label').textContent = `Floor ${status.towerLevel} / 100`;
  document.getElementById('tower-milestone-label').textContent = status.atCap
    ? 'Tower fully climbed!'
    : `Next bonus at floor ${status.nextMilestoneAt}`;

  const pct = status.atCap ? 100 : Math.max(0, Math.min(100, (status.towerExp / status.expToNextLevel) * 100));
  document.getElementById('tower-bar-fill').style.width = pct + '%';
  document.getElementById('tower-exp-text').textContent = status.atCap
    ? `Permanent bonus earned: +${status.permanentBonus.atk} ATK / +${status.permanentBonus.hp} HP`
    : `${status.towerExp}/${status.expToNextLevel} EXP — permanent bonus so far: +${status.permanentBonus.atk} ATK / +${status.permanentBonus.hp} HP`;

  const fightCard = document.getElementById('tower-fight-card');
  if (status.atCap) {
    fightCard.classList.add('hidden');
  } else {
    fightCard.classList.remove('hidden');
    document.getElementById('tower-monster-icon').src = `/images/monsters/${status.currentMonster.image}.svg`;
    document.getElementById('tower-monster-name').textContent = status.currentMonster.name;
    document.getElementById('tower-monster-meta').textContent = `${status.currentMonster.exp_reward} EXP / ${status.currentMonster.gold_reward} Gold`;
  }
}

document.getElementById('tower-attack-btn').addEventListener('click', async () => {
  try {
    const data = await api('/tower/attack', { method: 'POST' });
    state.character = data.character;
    updateTopBar();
    renderTowerStatus(data.status);
    if (data.victory) {
      let msg = `Victory! +${data.expGained} Tower EXP, +${data.goldGained} Gold`;
      if (data.crits > 0) msg += ` (${data.crits} crit${data.crits > 1 ? 's' : ''}!)`;
      if (data.milestoneHit) msg += ` — Floor ${data.milestoneHit} milestone! +1 ATK / +5 HP permanently.`;
      else if (data.towerLeveledUp) msg += ' — Floor cleared!';
      showToast(msg);
    } else {
      showToast('Defeated. Try again once you level up a bit.', true);
    }
  } catch (err) {
    showToast(err.message, true);
  }
});

// ---------- Crafting ----------
async function loadCraftingPanel() {
  try {
    const [materialsData, recipesData] = await Promise.all([
      api('/crafting/materials'),
      api('/crafting/recipes'),
    ]);
    renderMaterialsGrid(materialsData.materials);
    renderRecipesList(recipesData.recipes);
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderMaterialsGrid(materials) {
  const grid = document.getElementById('materials-grid');
  grid.innerHTML = '';
  materials.forEach((m) => {
    const card = document.createElement('div');
    card.className = `material-card ${m.quantity === 0 ? 'empty' : ''}`;
    card.innerHTML = `
      <img src="/images/materials/${m.image}.svg" alt="" />
      <div>
        <div class="mat-name">${m.name}</div>
        <div class="mat-qty">${m.quantity}</div>
        ${m.quantity > 0 ? '<button class="market-list-btn btn-list-material">List</button>' : ''}
      </div>
    `;
    const listBtn = card.querySelector('.btn-list-material');
    if (listBtn) {
      listBtn.addEventListener('click', async () => {
        const qty = window.prompt(`List how many ${m.name} (you have ${m.quantity})?`, '1');
        if (!qty) return;
        const qtyNum = parseInt(qty, 10);
        if (!qtyNum || qtyNum < 1 || qtyNum > m.quantity) {
          showToast('Enter a valid quantity.', true);
          return;
        }
        const price = window.prompt(`Total price for ${qtyNum}x ${m.name}?`);
        if (!price) return;
        const priceNum = parseInt(price, 10);
        if (!priceNum || priceNum < 1) {
          showToast('Enter a valid price.', true);
          return;
        }
        try {
          await api('/marketplace/list-material', { method: 'POST', body: JSON.stringify({ materialId: m.id, quantity: qtyNum, price: priceNum }) });
          showToast(`Listed ${qtyNum}x ${m.name} for ${priceNum} gold.`);
          loadCraftingPanel();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }
    grid.appendChild(card);
  });
}

function renderRecipesList(recipes) {
  const list = document.getElementById('recipes-list');
  list.innerHTML = '';
  recipes.forEach((r) => {
    const row = document.createElement('div');
    row.className = `recipe-row ${r.craftable ? 'recipe-craftable' : ''}`;
    const statParts = [];
    if (r.bonus_atk) statParts.push(`+${r.bonus_atk} ATK`);
    if (r.bonus_hp) statParts.push(`+${r.bonus_hp} HP`);
    row.innerHTML = `
      <div class="row-with-icon">
        <img class="row-icon" src="/images/items/${r.item_image}.svg" alt="" />
        <div>
          <span class="name rarity-${r.rarity}">${r.item_name}</span> <span class="item-meta">(${r.slot}, req. Lv.${r.required_level})</span> ${ownedTagHtml(r.owned_item_count)}
          <div class="item-bonus">${statParts.join(' / ')}</div>
          <div class="recipe-progress ${r.owned_quantity >= r.materials_needed ? 'met' : 'unmet'}">
            ${r.material_name}: ${r.owned_quantity}/${r.materials_needed} — ${r.gold_cost.toLocaleString()} Gold
          </div>
        </div>
      </div>
      <button class="btn-primary" ${r.craftable ? '' : 'disabled'}>Craft</button>
    `;
    row.querySelector('button').addEventListener('click', async () => {
      try {
        const data = await api('/crafting/craft', { method: 'POST', body: JSON.stringify({ itemTemplateId: r.item_template_id }) });
        state.character = data.character;
        updateTopBar();
        showToast(`Crafted ${r.item_name}!`);
        loadCraftingPanel();
      } catch (err) {
        showToast(err.message, true);
      }
    });
    list.appendChild(row);
  });
}

// ---------- Market ----------
document.querySelectorAll('#market-subtabs .market-subtab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#market-subtabs .market-subtab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('market-browse-view').classList.toggle('hidden', btn.dataset.marketView !== 'browse');
    document.getElementById('market-mine-view').classList.toggle('hidden', btn.dataset.marketView !== 'mine');
    if (btn.dataset.marketView === 'mine') loadMyListings();
  });
});

async function loadMarketPanel() {
  await loadMarketBrowse();
}

function marketRowIconAndName(l) {
  if (l.listing_type === 'equipment') {
    return {
      icon: `/images/items/${l.item_image}.svg`,
      label: `${l.item_name}${l.upgrade_level > 0 ? ` +${l.upgrade_level}` : ''}`,
      meta: `(${l.slot}, req. Lv.${l.required_level})`,
      rarityClass: `rarity-${l.item_rarity}`,
      statsText: bonusText(l),
    };
  }
  return {
    icon: `/images/materials/${l.material_image}.svg`,
    label: `${l.material_name} x${l.quantity}`,
    meta: '',
    rarityClass: '',
    statsText: '',
  };
}

async function loadMarketBrowse() {
  try {
    const data = await api('/marketplace/listings');
    const list = document.getElementById('market-browse-list');
    if (data.listings.length === 0) {
      list.innerHTML = '<p class="empty-msg">Nothing listed right now. Be the first to sell something.</p>';
      return;
    }
    list.innerHTML = '';
    data.listings.forEach((l) => {
      const { icon, label, meta, rarityClass, statsText } = marketRowIconAndName(l);
      const row = document.createElement('div');
      row.className = 'market-row';
      row.innerHTML = `
        <div class="row-with-icon">
          <img class="row-icon" src="${icon}" alt="" />
          <div>
            <span class="name ${rarityClass}">${label}</span> ${meta ? `<span class="item-meta">${meta}</span>` : ''}
            ${statsText ? `<div class="item-bonus">${statsText}</div>` : ''}
            <div class="market-seller">Sold by ${l.seller_name}</div>
          </div>
        </div>
        <button class="btn-primary btn-market-buy">${l.price.toLocaleString()} Gold</button>
      `;
      row.querySelector('.btn-market-buy').addEventListener('click', async () => {
        if (!window.confirm(`Buy ${label} for ${l.price.toLocaleString()} gold?`)) return;
        try {
          const result = await api(`/marketplace/buy/${l.id}`, { method: 'POST' });
          state.character.gold = result.goldRemaining;
          updateTopBar();
          showToast(`Bought ${label}!`);
          loadMarketBrowse();
        } catch (err) {
          showToast(err.message, true);
        }
      });
      list.appendChild(row);
    });
  } catch (err) {
    showToast(err.message, true);
  }
}

async function loadMyListings() {
  try {
    const data = await api('/marketplace/my-listings');
    const list = document.getElementById('market-mine-list');
    if (data.listings.length === 0) {
      list.innerHTML = '<p class="empty-msg">You haven\'t listed anything yet.</p>';
      return;
    }
    list.innerHTML = '';
    data.listings.forEach((l) => {
      const { icon, label, meta, rarityClass, statsText } = marketRowIconAndName(l);
      const row = document.createElement('div');
      row.className = 'market-row';
      row.innerHTML = `
        <div class="row-with-icon">
          <img class="row-icon" src="${icon}" alt="" />
          <div>
            <span class="name ${rarityClass}">${label}</span> ${meta ? `<span class="item-meta">${meta}</span>` : ''}
            ${statsText ? `<div class="item-bonus">${statsText}</div>` : ''}
            <div class="market-seller">${l.price.toLocaleString()} Gold <span class="market-status-tag ${l.status}">${l.status}</span></div>
          </div>
        </div>
        ${l.status === 'active' ? '<button class="btn-ghost btn-market-cancel">Cancel</button>' : ''}
      `;
      const cancelBtn = row.querySelector('.btn-market-cancel');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', async () => {
          try {
            await api(`/marketplace/cancel/${l.id}`, { method: 'POST' });
            showToast('Listing cancelled.');
            loadMyListings();
          } catch (err) {
            showToast(err.message, true);
          }
        });
      }
      list.appendChild(row);
    });
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---------- Skills ----------
async function loadSkillsPanel() {
  try {
    const data = await api('/skills');
    renderSkillsList(data.skills);
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderSkillsList(skills) {
  const list = document.getElementById('skills-list');
  list.innerHTML = '';
  skills.forEach((s) => {
    const card = document.createElement('div');
    card.className = `skill-card ${s.atCap ? 'at-cap' : ''}`;
    const pct = Math.round((s.level / s.maxLevel) * 100);
    const unit = s.skillType === 'wealth' || s.skillType === 'wisdom' ? '%'
      : s.skillType === 'precision' ? ' pts crit'
        : s.skillType === 'fortitude' ? ' HP' : ' ATK';

    card.innerHTML = `
      <img class="skill-icon" src="/images/skills/${s.image}.svg" alt="" />
      <div class="skill-info">
        <span class="skill-name">${s.name}</span><span class="skill-level-tag">Level ${s.level}/${s.maxLevel}${s.level > 0 ? ` — currently +${s.currentBonus}${unit}` : ''}</span>
        <div class="skill-desc">${s.description}</div>
        <div class="skill-progress-bar"><div class="skill-progress-fill" style="width:${pct}%"></div></div>
        ${s.atCap ? '<div class="skill-next">Maxed out!</div>' : `<div class="skill-next">Next level: +${s.nextLevelBonus}${unit} — ${s.nextLevelCost.toLocaleString()} Gold</div>`}
      </div>
      <button class="btn-primary skill-upgrade-btn" ${s.atCap ? 'disabled' : ''}>${s.atCap ? 'Maxed' : `Upgrade (${s.nextLevelCost.toLocaleString()}g)`}</button>
    `;
    const btn = card.querySelector('.skill-upgrade-btn');
    if (!s.atCap) {
      btn.addEventListener('click', async () => {
        try {
          const data = await api('/skills/upgrade', { method: 'POST', body: JSON.stringify({ skillType: s.skillType }) });
          state.character = data.character;
          updateTopBar();
          showToast(`${s.name} is now level ${data.newLevel}!`);
          loadSkillsPanel();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }
    list.appendChild(card);
  });
}

// ---------- Go ----------
boot();
