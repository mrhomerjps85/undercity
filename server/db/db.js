// db.js - Database connection + schema setup
// Uses Node's built-in node:sqlite (requires Node.js >= 22.5.0)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// In production, set DB_PATH to a file on your host's persistent disk (e.g. Render's
// persistent disk mounts at a path you choose, like /var/data - set DB_PATH=/var/data/game.db).
// Without it, this defaults to living next to this file, which is fine for local dev but
// will NOT survive a redeploy on most hosts (their app filesystem is ephemeral, only the
// disk you explicitly attach persists).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'game.db');

// For a fresh dev setup, run `npm run reset-db` to wipe and reseed the world.
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER DEFAULT 0,
  banned INTEGER DEFAULT 0,
  last_news_read_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  leader_character_id INTEGER,
  clan_level INTEGER DEFAULT 1,
  clan_xp INTEGER DEFAULT 0,
  vault_gold INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Simplified stat model: a character only has Attack and HP as allocatable stats.
-- Defense exists purely as a byproduct of equipped gear (see item_templates.bonus_defense).
-- tutorial_step: 0 = not started, 1 = waiting to move, 2 = waiting to win a fight,
-- 3 = waiting to accept a quest, 4 = waiting to equip an item, 5 = done (or skipped).
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
  tutorial_step INTEGER DEFAULT 0,
  rebirth_count INTEGER DEFAULT 0,
  tower_level INTEGER DEFAULT 0,
  tower_exp INTEGER DEFAULT 0,
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
  -- Which rebirth generation this attempt belongs to (character.rebirth_count at accept
  -- time). Completing a quest only marks it done for THIS generation - after rebirthing,
  -- the character's rebirth_count moves past this row's generation, so the quest becomes
  -- acceptable again without deleting the historical record of the earlier completion.
  generation INTEGER DEFAULT 0,
  -- required_count/rewards scale up per generation (+25% kills, proportional rewards) -
  -- locked in at accept time so a quest's difficulty/payout doesn't shift mid-attempt.
  effective_required_count INTEGER,
  effective_reward_exp INTEGER,
  effective_reward_gold INTEGER,
  -- The item actually granted on completion - gen 0 is the original item_template_id;
  -- gen 1+ points at a dynamically-created "(Gen N)" item with boosted stats, never the
  -- same row as the original, so repeat completions can't grant a duplicate of the exact
  -- same unique reward.
  granted_item_template_id INTEGER,
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
  dropped_items TEXT, -- JSON array of item names, e.g. '["Steel Pipe"]' - null/empty if none
  dropped_materials TEXT, -- JSON array of material names, same format
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

-- Admin-posted announcements. author_username is stored as plain text (not a foreign key)
-- so posts stay intact and correctly attributed even if that admin account is later deleted.
CREATE TABLE IF NOT EXISTS news_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'update', -- update, event, maintenance
  author_username TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Audit trail for admin impersonation - who impersonated whom and when, plus when they
-- exited. Kept simple (usernames snapshotted as text) since this is for accountability if
-- a player ever asks "did someone touch my account," not a compliance system.
CREATE TABLE IF NOT EXISTS impersonation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id INTEGER NOT NULL,
  admin_username TEXT NOT NULL,
  target_user_id INTEGER NOT NULL,
  target_username TEXT NOT NULL,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT
);

-- Room-based NPCs. npc_type distinguishes what a client should render/offer when standing
-- in their room - 'rebirth' shows the Rebirth card, other types are just flavor for now but
-- this stays generic so future NPCs (shopkeepers, quest-givers) don't need a new table.
CREATE TABLE IF NOT EXISTS npcs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  room_id INTEGER NOT NULL,
  description TEXT,
  image TEXT,
  npc_type TEXT NOT NULL DEFAULT 'flavor',
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);

-- Crafting material TYPES (one per slot per tier - e.g. "Forged Blade Core" is the weapon
-- material for the level-15 tier). Not equippable, no stats - purely crafting ingredients.
CREATE TABLE IF NOT EXISTS crafting_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  tier INTEGER NOT NULL, -- 15, 30, or 45
  slot TEXT NOT NULL,
  image TEXT,
  description TEXT
);

-- How many of each material a character is holding. Materials stack (unlike equipment,
-- which is one row per instance) - this is a separate table rather than extending
-- character_inventory specifically so the existing equip/paperdoll/tooltip code (which
-- assumes one row = one equippable instance) never has to think about quantities at all.
CREATE TABLE IF NOT EXISTS character_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL,
  material_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (character_id) REFERENCES characters(id),
  FOREIGN KEY (material_id) REFERENCES crafting_materials(id)
);

-- Which monsters drop which crafting materials, and at what chance - the material
-- equivalent of monster_drops (which is for finished equipment).
CREATE TABLE IF NOT EXISTS monster_material_drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monster_template_id INTEGER NOT NULL,
  material_id INTEGER NOT NULL,
  drop_chance REAL NOT NULL DEFAULT 0.1,
  FOREIGN KEY (monster_template_id) REFERENCES monster_templates(id),
  FOREIGN KEY (material_id) REFERENCES crafting_materials(id)
);

-- What it costs to craft a given item at the Blacksmith - one recipe per craftable item,
-- always a single matching material type (by design, no cross-material substitution) plus gold.
CREATE TABLE IF NOT EXISTS crafting_recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_template_id INTEGER NOT NULL,
  material_id INTEGER NOT NULL,
  materials_needed INTEGER NOT NULL,
  gold_cost INTEGER NOT NULL,
  FOREIGN KEY (item_template_id) REFERENCES item_templates(id),
  FOREIGN KEY (material_id) REFERENCES crafting_materials(id)
);

-- Player-to-player marketplace. Listing an equipment item DELETES it from
-- character_inventory entirely (snapshotting item_template_id/upgrade_level here instead)
-- rather than adding an "escrowed" flag to that table - this way every existing
-- inventory/equip/upgrade/sell query stays correct with zero changes, since a listed item
-- simply doesn't exist there anymore until it's bought back out (or the listing is
-- cancelled) via a fresh INSERT, the same way buying/crafting already creates new rows.
-- Material listings instead just deduct/restore character_materials.quantity, reusing
-- that table's existing stacking behavior.
CREATE TABLE IF NOT EXISTS marketplace_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_character_id INTEGER NOT NULL,
  seller_name TEXT NOT NULL, -- snapshot so a listing still displays correctly even if the seller is later deleted
  listing_type TEXT NOT NULL, -- 'equipment' | 'material'
  item_template_id INTEGER, -- set for equipment listings
  upgrade_level INTEGER DEFAULT 0, -- snapshot of the upgrade level being sold (equipment only)
  material_id INTEGER, -- set for material listings
  quantity INTEGER DEFAULT 1, -- units being sold (materials only - always 1 for equipment)
  price INTEGER NOT NULL, -- total price for the whole listing, not per-unit
  status TEXT NOT NULL DEFAULT 'active', -- active | sold | cancelled | expired
  listed_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  FOREIGN KEY (seller_character_id) REFERENCES characters(id),
  FOREIGN KEY (item_template_id) REFERENCES item_templates(id),
  FOREIGN KEY (material_id) REFERENCES crafting_materials(id)
);

-- One row per (character, potion_type) - buying a potion upserts this row, refreshing
-- expires_at to a fresh 5 minutes rather than stacking duration. Potion catalog itself
-- (name/price/magnitude/image) lives in code (server/potions.js), not a database table -
-- there are only 5 of them and they're not tradeable/storable, so a whole item_templates-
-- style catalog would be more structure than this needs.
CREATE TABLE IF NOT EXISTS character_active_buffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL,
  potion_type TEXT NOT NULL, -- crit | attack | fortitude | exp | gold
  magnitude REAL NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (character_id) REFERENCES characters(id)
);

-- One row per (character, skill_type) - the permanent counterpart to potions. Where a
-- potion is "gold for temporary power," a skill is "gold for permanent power" - leveled up
-- one level at a time with an escalating gold cost, capped at 25 per skill. The catalog
-- (magnitude-per-level formula, cost formula, max level) lives in code
-- (server/skills.js), not a database table, same reasoning as the potion catalog.
CREATE TABLE IF NOT EXISTS character_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL,
  skill_type TEXT NOT NULL, -- attack | fortitude | precision | wealth | wisdom
  level INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (character_id) REFERENCES characters(id)
);

-- Pet catalog - like item_templates but simpler (no slot/set, no upgrade levels). Each
-- pet leans toward one bonus category, with rarity determining magnitude - kept modest
-- since these are free RNG finds, not a deliberate investment like Skills.
CREATE TABLE IF NOT EXISTS pet_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  rarity TEXT NOT NULL,
  bonus_type TEXT NOT NULL, -- atk | hp | crit | gold | exp
  bonus_value REAL NOT NULL,
  image TEXT,
  description TEXT
);

-- One row per OWNED copy - duplicates are allowed and simply sit in the collection, since
-- only ONE pet (by template) is ever active at a time regardless of how many copies of it
-- exist. active_pet_template_id lives on characters, not here, since which copy is active
-- is meaningless when duplicates are functionally identical.
CREATE TABLE IF NOT EXISTS character_pets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL,
  pet_template_id INTEGER NOT NULL,
  obtained_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (character_id) REFERENCES characters(id),
  FOREIGN KEY (pet_template_id) REFERENCES pet_templates(id)
);

-- Depositing an item removes it from character_inventory and creates a row here (same
-- delete-and-recreate pattern already used for Marketplace listings) - the Leader/Officers
-- can then assign a vault item to a specific member, which deletes the vault row and
-- creates a fresh character_inventory row for them. Not a free-for-all withdraw - the
-- point is the leadership can direct rewards to whoever earned them.
CREATE TABLE IF NOT EXISTS clan_vault_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clan_id INTEGER NOT NULL,
  item_template_id INTEGER NOT NULL,
  upgrade_level INTEGER DEFAULT 0,
  donated_by_name TEXT,
  donated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (clan_id) REFERENCES clans(id),
  FOREIGN KEY (item_template_id) REFERENCES item_templates(id)
);

-- A raid is a one-time event, not a persistent respawning boss like the world bosses -
-- created by a clan's Leader/Officer, sits in 'gathering' until 3+ members have joined
-- (at which point it auto-flips to 'active' and can be attacked), then 'completed' once
-- the boss dies or 'expired' if gathering ran out the clock without enough joiners.
CREATE TABLE IF NOT EXISTS raids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clan_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'gathering', -- gathering | active | completed | failed | expired
  boss_key TEXT NOT NULL DEFAULT 'rift_sovereign', -- which of the raid boss catalog this fight is against
  max_hp INTEGER NOT NULL,
  current_hp INTEGER NOT NULL,
  -- The party's shared HP pool - snapshotted once when the raid activates (roster locks
  -- at that point, no one can join mid-fight), then depletes round over round like a real
  -- health bar. Hitting 0 fails the raid outright, no rewards - the actual stakes this
  -- turn-based rework adds that the old "everyone pokes it whenever" model never had.
  party_max_hp INTEGER,
  party_current_hp INTEGER,
  current_round INTEGER NOT NULL DEFAULT 1,
  created_by_name TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  gathering_expires_at TEXT NOT NULL,
  completed_at TEXT,
  reward_summary_json TEXT,
  FOREIGN KEY (clan_id) REFERENCES clans(id)
);

CREATE TABLE IF NOT EXISTS raid_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raid_id INTEGER NOT NULL,
  character_id INTEGER NOT NULL,
  character_name TEXT NOT NULL,
  damage_dealt INTEGER DEFAULT 0,
  last_attack_at TEXT,
  is_ready INTEGER DEFAULT 0,
  FOREIGN KEY (raid_id) REFERENCES raids(id),
  FOREIGN KEY (character_id) REFERENCES characters(id)
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

-- One row per boss kill, recording the full contributor breakdown (JSON: characterName,
-- damageDealt, damageSharePct, expGained, goldGained, droppedItems per person) so "who got
-- what" is answerable after the fact, not just visible transiently to whoever landed the
-- killing blow. contributors_json is denormalized on purpose - this is a historical record
-- of exactly what was granted at the time, not something that should change if e.g. a
-- character is later renamed or deleted.
CREATE TABLE IF NOT EXISTS world_boss_kill_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_boss_id INTEGER NOT NULL,
  boss_name TEXT NOT NULL,
  generation INTEGER NOT NULL,
  killed_at TEXT DEFAULT (datetime('now')),
  total_damage INTEGER NOT NULL,
  contributors_json TEXT NOT NULL,
  FOREIGN KEY (world_boss_id) REFERENCES world_bosses(id)
);
`);

// ---------------------------------------------------------------------
// Lightweight migrations - "CREATE TABLE IF NOT EXISTS" only helps on a brand-new
// database. On a database that already has a table (like a live production one),
// adding a new column to that CREATE statement above does nothing - the table already
// exists, so it's skipped entirely. This adds any missing columns without touching
// existing rows, so shipping a schema change never requires wiping real player data.
// ---------------------------------------------------------------------
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = columns.some((c) => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[migration] added column ${table}.${column}`);
  }
}

ensureColumn('characters', 'tutorial_step', 'INTEGER DEFAULT 0');
ensureColumn('users', 'is_admin', 'INTEGER DEFAULT 0');
ensureColumn('users', 'banned', 'INTEGER DEFAULT 0');
ensureColumn('users', 'last_news_read_at', 'TEXT');
ensureColumn('characters', 'rebirth_count', 'INTEGER DEFAULT 0');
ensureColumn('characters', 'tower_level', 'INTEGER DEFAULT 0');
ensureColumn('characters', 'tower_exp', 'INTEGER DEFAULT 0');
ensureColumn('combat_log', 'dropped_items', 'TEXT');
ensureColumn('combat_log', 'dropped_materials', 'TEXT');
ensureColumn('character_quests', 'generation', 'INTEGER DEFAULT 0');
ensureColumn('character_quests', 'effective_required_count', 'INTEGER');
ensureColumn('character_quests', 'effective_reward_exp', 'INTEGER');
ensureColumn('character_quests', 'effective_reward_gold', 'INTEGER');
ensureColumn('character_quests', 'granted_item_template_id', 'INTEGER');
ensureColumn('characters', 'clan_role', "TEXT DEFAULT 'member'"); // 'leader' | 'officer' | 'member'
ensureColumn('clans', 'clan_level', 'INTEGER DEFAULT 1');
ensureColumn('clans', 'clan_xp', 'INTEGER DEFAULT 0');
ensureColumn('clans', 'vault_gold', 'INTEGER DEFAULT 0');

// Raids table existed before reward_summary_json and the turn-based rework's party HP
// fields were added - CREATE TABLE IF NOT EXISTS only helps a brand-new database, so an
// already-existing raids/raid_participants table (from before any of these columns
// existed) needs each one added explicitly here, or every read of that table crashes with
// "no such column" - exactly what happened in production before this fix.
ensureColumn('raids', 'reward_summary_json', 'TEXT');
ensureColumn('raids', 'party_max_hp', 'INTEGER');
ensureColumn('raids', 'party_current_hp', 'INTEGER');
ensureColumn('raids', 'current_round', 'INTEGER DEFAULT 1');
ensureColumn('raid_participants', 'is_ready', 'INTEGER DEFAULT 0');
ensureColumn('characters', 'active_pet_template_id', 'INTEGER');
ensureColumn('raids', 'boss_key', "TEXT DEFAULT 'rift_sovereign'");

// Existing clan leaders (from before roles existed) need their role backfilled - otherwise
// a clan created before this update would have a leader_character_id but nobody actually
// holding the 'leader' role, locking that clan out of leader-only actions.
db.exec(`
  UPDATE characters SET clan_role = 'leader'
  WHERE id IN (SELECT leader_character_id FROM clans WHERE leader_character_id IS NOT NULL)
`);

// Existing character_quests rows (created before the rebirth-generation system existed)
// have NULL effective_* columns - backfill them from their quest_template's original
// values so they behave exactly as they always did, rather than showing as 0/undefined.
db.exec(`
  UPDATE character_quests
  SET effective_required_count = (SELECT required_count FROM quest_templates WHERE id = character_quests.quest_template_id)
  WHERE effective_required_count IS NULL
`);
db.exec(`
  UPDATE character_quests
  SET effective_reward_exp = (SELECT reward_exp FROM quest_templates WHERE id = character_quests.quest_template_id)
  WHERE effective_reward_exp IS NULL
`);
db.exec(`
  UPDATE character_quests
  SET effective_reward_gold = (SELECT reward_gold FROM quest_templates WHERE id = character_quests.quest_template_id)
  WHERE effective_reward_gold IS NULL
`);
db.exec(`
  UPDATE character_quests
  SET granted_item_template_id = (SELECT reward_item_template_id FROM quest_templates WHERE id = character_quests.quest_template_id)
  WHERE granted_item_template_id IS NULL
`);

// Unique indexes (not table-level constraints, since these tables already exist on live
// databases and SQLite can't ALTER TABLE to add a constraint after the fact - an index
// enforces the same uniqueness and works identically with ON CONFLICT). These back the
// upsert-based seeding in seed.js: every zone/monster/item/quest insert there is
// "insert or update by name," so re-running the seeder on an already-populated database
// safely adds only what's missing instead of either erroring or silently doing nothing.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_zones_name ON zones(name)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_monster_templates_name ON monster_templates(name)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_item_templates_name ON item_templates(name)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_quest_templates_name ON quest_templates(name)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_item_sets_name ON item_sets(name)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_world_bosses_name ON world_bosses(name)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_monster_drops_pair ON monster_drops(monster_template_id, item_template_id)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_set_bonuses_pair ON set_bonuses(set_id, pieces_required)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_world_boss_drops_pair ON world_boss_drops(world_boss_id, item_template_id)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_npcs_name ON npcs(name)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_crafting_materials_name ON crafting_materials(name)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_monster_material_drops_pair ON monster_material_drops(monster_template_id, material_id)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_character_materials_pair ON character_materials(character_id, material_id)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_crafting_recipes_item ON crafting_recipes(item_template_id)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_character_active_buffs_pair ON character_active_buffs(character_id, potion_type)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_raid_participants_pair ON raid_participants(raid_id, character_id)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_character_skills_pair ON character_skills(character_id, skill_type)');

// ---------------------------------------------------------------------
// Monster reward rebalancing - runs on every startup, not just once. Monster exp/gold
// rewards were originally hand-picked across several separate content passes (levels
// 1-30, then a 30-35 bridge, then 35-50), which drifted out of sync with the actual EXP
// curve (expToNextLevel grows faster than linear) - some level ranges ended up requiring
// far more grinding than others for no real reason. This recalculates every monster's
// reward directly from its level and the same curve the game actually uses, so the
// "kills needed per level" pacing stays consistent even if more monsters get added later.
// Named bosses get an intentional 2.5x reward multiplier - that cliff is meant to be
// there, unlike the accidental unevenness this fixes everywhere else.
// ---------------------------------------------------------------------
function rebalanceMonsterRewards() {
  const { expToNextLevel } = require('../gameLogic');
  const BOSS_NAMES = new Set(['Ganglord Sid', 'The Overseer', 'The Warden', 'Dockmaster Kane', 'Zhul, the Devourer', 'The Wound-Walker', 'The Depth-Caller']);
  const K_REGULAR = 25; // target kills-to-level-up on a same-level regular monster
  const BOSS_MULTIPLIER = 2.5;
  const GOLD_RATIO = 0.47; // matches the ratio already established by the original hand-tuned values

  const monsters = db.prepare('SELECT id, name, level FROM monster_templates').all();
  const update = db.prepare('UPDATE monster_templates SET exp_reward = ?, gold_reward = ? WHERE id = ?');
  for (const m of monsters) {
    const needed = expToNextLevel(m.level);
    let exp = Math.max(8, Math.round(needed / K_REGULAR));
    if (BOSS_NAMES.has(m.name)) exp = Math.round(exp * BOSS_MULTIPLIER);
    const gold = Math.round(exp * GOLD_RATIO);
    update.run(exp, gold, m.id);
  }
}
// Quest rewards were designed as "3x the equivalent monster grind" (kill N monsters normally
// vs. get 3x the reward for doing it as a quest) - but they were hardcoded against monster
// rewards at the time each quest was written, so fixing monster rewards above silently broke
// that ratio for every quest that predates the fix. Recalculates from the (now-correct)
// monster rewards so the "3x for questing" policy actually holds. Must run AFTER
// rebalanceMonsterRewards() - it reads exp_reward values that function just corrected.
function rebalanceQuestRewards() {
  const QUEST_MULTIPLIER = 3;
  const quests = db.prepare('SELECT id, type, required_count, target_monster_template_id, target_item_template_id FROM quest_templates').all();
  const update = db.prepare('UPDATE quest_templates SET reward_exp = ?, reward_gold = ? WHERE id = ?');

  for (const q of quests) {
    let monster = null;
    if (q.type === 'kill' && q.target_monster_template_id) {
      monster = db.prepare('SELECT exp_reward, gold_reward FROM monster_templates WHERE id = ?').get(q.target_monster_template_id);
    } else if (q.type === 'collect' && q.target_item_template_id) {
      // Collect quests don't have a direct monster - use whichever monster drops the target item.
      const dropper = db.prepare(`
        SELECT mt.exp_reward, mt.gold_reward FROM monster_drops md
        JOIN monster_templates mt ON mt.id = md.monster_template_id
        WHERE md.item_template_id = ? LIMIT 1
      `).get(q.target_item_template_id);
      monster = dropper || null;
    }
    if (!monster) continue; // nothing to base the reward on - leave as-is rather than guess

    const exp = Math.round(monster.exp_reward * q.required_count * QUEST_MULTIPLIER);
    const gold = Math.round(monster.gold_reward * q.required_count * QUEST_MULTIPLIER);
    update.run(exp, gold, q.id);
  }
}

module.exports = db;
module.exports.rebalanceMonsterRewards = rebalanceMonsterRewards;
module.exports.rebalanceQuestRewards = rebalanceQuestRewards;
