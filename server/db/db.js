// db.js - Database connection + schema setup
// Uses Node's built-in node:sqlite (requires Node.js >= 22.5.0)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'game.db');

// For a fresh dev setup, run `npm run reset-db` to wipe and reseed the world.
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  leader_character_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Simplified stat model: a character only has Attack and HP as allocatable stats.
-- Defense exists purely as a byproduct of equipped gear (see item_templates.bonus_defense).
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT UNIQUE NOT NULL,
  level INTEGER DEFAULT 1,
  exp INTEGER DEFAULT 0,
  gold INTEGER DEFAULT 100,
  attack_points INTEGER DEFAULT 0,
  hp_points INTEGER DEFAULT 0,
  current_hp INTEGER DEFAULT 50,
  current_room_id INTEGER,
  clan_id INTEGER,
  avatar TEXT DEFAULT 'default',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (clan_id) REFERENCES clans(id)
);

CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  min_level INTEGER DEFAULT 1,
  image TEXT,
  is_dungeon INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  grid_x INTEGER NOT NULL,
  grid_y INTEGER NOT NULL,
  image TEXT,
  is_entrance INTEGER DEFAULT 0,
  north_room_id INTEGER,
  south_room_id INTEGER,
  east_room_id INTEGER,
  west_room_id INTEGER,
  FOREIGN KEY (zone_id) REFERENCES zones(id)
);

CREATE TABLE IF NOT EXISTS monster_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  level INTEGER NOT NULL,
  max_hp INTEGER NOT NULL,
  attack INTEGER NOT NULL,
  defense INTEGER NOT NULL,
  exp_reward INTEGER NOT NULL,
  gold_reward INTEGER NOT NULL,
  image TEXT
);

-- Monsters placed in rooms. is_alive + respawn_at implement the respawn timer;
-- higher-level monsters take longer to respawn (see gameLogic.respawnSeconds).
CREATE TABLE IF NOT EXISTS room_monsters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  monster_template_id INTEGER NOT NULL,
  is_alive INTEGER DEFAULT 1,
  respawn_at TEXT,
  FOREIGN KEY (room_id) REFERENCES rooms(id),
  FOREIGN KEY (monster_template_id) REFERENCES monster_templates(id)
);

-- source distinguishes shop-buyable gear from dungeon-exclusive / quest-reward gear.
-- is_quest_item marks items that are quest turn-in material (not equippable, not sellable).
-- Note: gear only grants Attack/HP bonuses. There is no player-side Defense stat.
-- rarity drives the color-coded border/name in the UI (common/uncommon/rare/epic/legendary).
-- set_id links an item into a themed set (see item_sets/set_bonuses) - null if not part of one.
CREATE TABLE IF NOT EXISTS item_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slot TEXT NOT NULL, -- weapon, chest, head, legs, boots, hands, neck, shield, quest
  required_level INTEGER DEFAULT 1,
  bonus_atk INTEGER DEFAULT 0,
  bonus_hp INTEGER DEFAULT 0,
  price INTEGER DEFAULT 0,
  source TEXT DEFAULT 'shop', -- shop, dungeon, quest
  is_quest_item INTEGER DEFAULT 0,
  rarity TEXT DEFAULT 'common', -- common, uncommon, rare, epic, legendary, mythic
  set_id INTEGER,
  image TEXT,
  FOREIGN KEY (set_id) REFERENCES item_sets(id)
);

-- A themed group of items (e.g. "Bounty Hunter Set") that grants a bonus when enough
-- pieces are equipped simultaneously.
CREATE TABLE IF NOT EXISTS item_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT
);

-- Bonuses unlocked at different equipped-piece thresholds for a set (e.g. 2pc / 3pc).
CREATE TABLE IF NOT EXISTS set_bonuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL,
  pieces_required INTEGER NOT NULL,
  bonus_atk INTEGER DEFAULT 0,
  bonus_hp INTEGER DEFAULT 0,
  FOREIGN KEY (set_id) REFERENCES item_sets(id)
);

-- What a monster can drop, and how often. drop_chance is 0.0-1.0.
-- If the linked item is a quest item, combat.js only rolls it for characters
-- with a matching active collect-quest, so quest-only drops don't clutter everyone's loot.
CREATE TABLE IF NOT EXISTS monster_drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monster_template_id INTEGER NOT NULL,
  item_template_id INTEGER NOT NULL,
  drop_chance REAL NOT NULL DEFAULT 0.1,
  FOREIGN KEY (monster_template_id) REFERENCES monster_templates(id),
  FOREIGN KEY (item_template_id) REFERENCES item_templates(id)
);

-- upgrade_level (0-5) is a risk-based enhancement applied per-item (see gameLogic's
-- upgrade formulas). Each level scales that specific item's bonus_atk/bonus_hp up.
CREATE TABLE IF NOT EXISTS character_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL,
  item_template_id INTEGER NOT NULL,
  equipped INTEGER DEFAULT 0,
  upgrade_level INTEGER DEFAULT 0,
  protected INTEGER DEFAULT 0,
  FOREIGN KEY (character_id) REFERENCES characters(id),
  FOREIGN KEY (item_template_id) REFERENCES item_templates(id)
);

-- type: 'kill' (progress = monsters killed) or 'collect' (progress = quest items gathered).
-- prerequisite_quest_id chains quests into a line (used for the dungeon quest line).
-- reward_item_template_id is typically a dungeon-exclusive item on the final quest in a chain.
CREATE TABLE IF NOT EXISTS quest_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL, -- kill | collect
  target_monster_template_id INTEGER,
  target_item_template_id INTEGER,
  required_count INTEGER NOT NULL,
  min_level INTEGER DEFAULT 1,
  prerequisite_quest_id INTEGER,
  reward_exp INTEGER DEFAULT 0,
  reward_gold INTEGER DEFAULT 0,
  reward_item_template_id INTEGER,
  zone_id INTEGER,
  FOREIGN KEY (target_monster_template_id) REFERENCES monster_templates(id),
  FOREIGN KEY (target_item_template_id) REFERENCES item_templates(id),
  FOREIGN KEY (prerequisite_quest_id) REFERENCES quest_templates(id),
  FOREIGN KEY (reward_item_template_id) REFERENCES item_templates(id),
  FOREIGN KEY (zone_id) REFERENCES zones(id)
);

CREATE TABLE IF NOT EXISTS character_quests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL,
  quest_template_id INTEGER NOT NULL,
  status TEXT DEFAULT 'active', -- active | completed
  progress_count INTEGER DEFAULT 0,
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (character_id) REFERENCES characters(id),
  FOREIGN KEY (quest_template_id) REFERENCES quest_templates(id)
);

CREATE TABLE IF NOT EXISTS combat_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL,
  monster_name TEXT,
  result TEXT,
  exp_gained INTEGER,
  gold_gained INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- channel is 'global' or 'clan:<clan_id>'. Kept so newly-connected clients can
-- load a bit of recent history instead of seeing an empty chat on join.
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  character_id INTEGER NOT NULL,
  character_name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- A world boss is shared server-wide (one HP pool for everyone, not per-character combat
-- resolved-in-one-call like regular monsters). current_hp persists across attacks from many
-- players. generation increments every time the boss dies and respawns, so old contribution
-- rows from a previous fight don't count toward the next one's reward split.
CREATE TABLE IF NOT EXISTS world_bosses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  room_id INTEGER NOT NULL,
  level INTEGER NOT NULL,
  max_hp INTEGER NOT NULL,
  current_hp INTEGER NOT NULL,
  attack INTEGER NOT NULL,
  defense INTEGER NOT NULL,
  is_alive INTEGER DEFAULT 1,
  respawn_at TEXT,
  respawn_seconds INTEGER NOT NULL,
  generation INTEGER DEFAULT 1,
  total_exp_reward INTEGER NOT NULL,
  total_gold_reward INTEGER NOT NULL,
  image TEXT,
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);

-- Per-character damage dealt during the boss's CURRENT generation (life). Used both to
-- enforce a per-attack cooldown (last_attack_at) and to split rewards proportionally
-- when the boss dies.
CREATE TABLE IF NOT EXISTS world_boss_contributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_boss_id INTEGER NOT NULL,
  character_id INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  damage_dealt INTEGER DEFAULT 0,
  last_attack_at TEXT,
  reward_claimed INTEGER DEFAULT 0,
  FOREIGN KEY (world_boss_id) REFERENCES world_bosses(id),
  FOREIGN KEY (character_id) REFERENCES characters(id)
);

-- What a world boss drops for each individual contributor when it dies (independent
-- roll per person, unlike the shared exp/gold split).
CREATE TABLE IF NOT EXISTS world_boss_drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_boss_id INTEGER NOT NULL,
  item_template_id INTEGER NOT NULL,
  drop_chance REAL NOT NULL DEFAULT 0.1,
  FOREIGN KEY (world_boss_id) REFERENCES world_bosses(id),
  FOREIGN KEY (item_template_id) REFERENCES item_templates(id)
);
`);

module.exports = db;
