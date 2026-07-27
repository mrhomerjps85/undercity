# Undercity — an Outwar-style browser MMO

A menu-driven browser MMO in the spirit of Outwar: create a character, navigate a
zone/room map with directional buttons, fight monsters for EXP/gold, level up,
equip gear, join a clan, and climb a shared leaderboard with other players.

## Requirements

- **Node.js 22.5.0 or newer.** This project uses Node's built-in `node:sqlite`
  module instead of a native npm database driver (like `better-sqlite3`), so
  there's nothing to compile — but it does mean you need a recent Node version.
  Check yours with `node -v`. If you're on an older Node, either upgrade
  ([nodejs.org](https://nodejs.org)) or see "Swapping the database" below.

## Setup

```bash
cd outwar-clone
npm install
npm start
```

Then open **http://localhost:3000** in your browser. The world (zones, rooms,
monsters, shop items) is seeded automatically the first time you run the
server. The SQLite database file lives at `server/db/game.db`.

To reset the world/wipe all players and start fresh:

```bash
npm run reset-db
```

Multiple people can play at once — just have them open the same URL (or your
machine's local network IP / a deployed URL) and register their own accounts.
Everyone shares the same world, monsters, and leaderboard.

## What's implemented

- **Accounts:** register/login with hashed passwords, session cookies.
- **Character creation:** name your character, starts with base stats.
- **Stats & leveling:** just **Attack** and **HP**, auto-assigned on every
  level-up (no manual allocation) using a 1:2 Attack:HP split — 1 Attack point
  and 2 HP points per level, favoring survivability. There is no Defense stat;
  nothing mitigates incoming damage. (Monsters keep their own internal
  `defense` value, which affects how much damage *you* deal to *them* — that's
  a monster property, not a player stat.) See `ATTACK_POINTS_PER_LEVEL` /
  `HP_POINTS_PER_LEVEL` in `server/gameLogic.js` if you want to retune the ratio.
- **World navigation:** 7 zones — Main St. (Lv.1), Angelio St. (Lv.5), City
  Hospital (Lv.8), and four dungeon zones, The Underworks (Lv.12), The
  Blacksite (Lv.18), The Docklands (Lv.24), and The Zhul Breach (Lv.35) —
  each a **9x9 grid (81 rooms)**, connected N/S/E/W, with a minimap, arrow
  buttons, and WASD keyboard movement, plus a Travel panel to jump between
  zones you've unlocked by level. Room names are procedurally generated per
  zone from themed word banks (see `generateRoomNameGrid` in
  `server/db/seed.js`) so the world didn't need 300+ hand-authored room
  names. 62 monster templates are spread across the world, with named
  bosses like Ganglord Sid, The Overseer, The Warden, Dockmaster Kane, and
  Zhul the Devourer staying unique).
- **Quest tracking lives in "My World"** — active quests (with live progress
  bars) and available quests to accept sit right next to the map and room
  view, with an Active/Available toggle. Progress updates immediately after
  every kill, no tab-switching required.
- **Combat:** click a monster in your room to fight it, or hit **Auto** to
  repeatedly fight whichever duplicates of that monster are still alive in
  the room (up to 30 attacks or until you stop it, level up notifications
  and quest completions still show up along the way). Combat resolves
  server-side turn-by-turn with a combat log, and rewards EXP + gold on
  victory. **Critical hits** scale with your equipped weapon's rarity (3%
  chance/1.4x damage unarmed, up to 22% chance/2.1x damage with a
  legendary weapon) - only the player can crit, monsters never do. Each
  monster in the room list shows an **Easy/Risky/Deadly badge**, estimated
  by running 20 silent combat simulations against your current stats before
  you even attack. Every fight starts at full HP - HP does not carry over
  between fights, so there's no HP bar in the topbar. Click the Level pill in
  the topbar for a quick dropdown showing current Attack, Max HP, and current HP
  without leaving whatever tab you're on. The Character sheet also shows a
  **Recent Battles** log (last 50 fights, win/loss and rewards) - the data
  was already being recorded on every attack, it just wasn't surfaced anywhere.
- **Monster respawns:** defeated monsters go on a cooldown that scales gently
  with their level (`20 + level * 8` seconds) before reappearing. Rooms can
  and do hold multiple copies of the same monster.
- **Quests:** 29 quests spanning levels 1-50, no gaps — kill quests and
  collect quests (gather N of an item a monster drops), some chained via
  prerequisites. Quests auto-complete and grant rewards the moment progress
  is met; collect quests consume the gathered items on completion. **All
  quests are visible from level 1** (including the dungeon chain), even
  ones you don't qualify for yet - locked ones show greyed-out with their
  requirement (e.g. "Requires level 20") instead of just not appearing, so
  you can see what's coming. Rewards are tuned to roughly 3x what an
  equivalent-level monster gives per kill, so grinding a quest feels
  meaningfully better than just farming XP.
- **The Underworks (dungeon):** a level-20+ zone with a 3-quest chain
  (`Into the Underworks I → II → The Warden's Fall`), each gated behind
  completing the last. The final quest rewards **Warden's Cleaver**, an
  exclusive weapon that's stronger than anything sold in the shop — dungeon
  and quest-reward gear is flagged `source: 'dungeon' | 'quest'` and is never
  purchasable, only earned.
- **The Blacksite (dungeon):** a second dungeon (Lv.18+), same pattern as
  the Underworks - a 3-quest chain (`Breaching the Blacksite → Corporate
  Cleanup → Silencing the Overseer`) ending in the exclusive **Overseer's
  Railgun**. Both dungeon bosses (The Warden, The Overseer) also have a
  30% chance to drop a bonus item on every kill even after their quest is
  done, so there's a reason to keep farming them.
- **The Docklands (dungeon, Lv.24+):** fills the level 24-31 gap between the
  older dungeons and The Zhul Breach's level-35 floor. A 3-quest chain
  (`Cargo Bust → Breaking the Cartel → The Dockmaster's Fall`) against an
  organized-crime smuggling operation, ending in the exclusive **Kane's
  Grapple Hook**. Forms a 3-piece set ("Smuggler's Legacy") with Smuggler's
  Vest and Kane's Golden Anchor (a 30% bonus drop from the boss).
- **Idempotent, self-updating world seeding:** `seed.js` used to gate its
  entire body behind a single "do any zones already exist?" check - which
  meant any *new* content added to the file after your first deploy (a new
  zone, new monsters) would never actually reach an already-seeded database
  on a normal restart, only a brand-new one. Every insert now upserts by
  name (or checks existence first) instead, so `seed()` always runs in
  full and safely: existing content is left untouched, and anything newly
  added to the file gets backfilled into a live database automatically.
  The one deliberate exception is the world boss - its creation upsert
  only ever touches its `name` column on conflict, so a server restart
  never resets an in-progress fight's HP or generation back to full.
  Verified by simulating a pre-Docklands production database, restarting
  against it, and confirming the new zone backfilled with zero duplicates
  anywhere (rooms, spawns, drops, set bonuses) across repeated restarts.
- **Monster & quest reward rebalancing:** every monster's exp/gold reward is
  calculated from a formula (`expToNextLevel(level) / 25`, named bosses get
  a 2.5x multiplier) rather than hand-picked per monster, and every quest's
  reward is always exactly `3x` its target monster's reward. Both run as a
  self-healing pass on **every server start** (see `rebalanceMonsterRewards`
  / `rebalanceQuestRewards` in `server/db/db.js`), not a one-time fix - so
  the "kills needed per level" pacing stays consistent even as more content
  gets added later, instead of silently drifting out of sync the way the
  original hand-picked values did across several separate content passes.
- **The Zhul Breach (dungeon, Lv.35+) - the current level cap:** the game's
  endgame finale. A longer 5-quest chain (`Cracks in Reality → Cult of the
  Breach → Echoes of the Warden → Into the Void → The Devourer's End`)
  culminating in a fight with **Zhul, the Devourer** (level 50). This boss
  is intentionally brutal - an ungeared level 50 character has essentially
  no chance (verified at 0% simulated win rate), but a properly-geared one
  (tested with a full Legendary loadout, no Mythic even) sits around
  90-100%, so it's meant to be a real gear check rather than a guaranteed
  win. Two "bridging" quests (`Brood of the Deep`, `Prototype Purge`) fill
  the gap between the older dungeons' level-28/30 caps and this zone's
  level-35 floor, using two new monsters added to the existing Underworks
  and Blacksite.
- **Mythic rarity + Zhul's Blessing:** a new tier above Legendary, used
  exclusively by this quest chain's rewards (Zhul's Grasp, Aegis,
  Annihilator, and Crown - the last a repeatable bonus drop from the final
  boss). These four form a set with 2/3/4-piece bonuses, capping out at
  +70 ATK / +220 HP for wearing all four - the best gear in the game.
- **World boss - The Kingpin:** a genuinely shared fight, sitting right at
  Main St.'s Town Square (the spawn point) so everyone runs into it. Unlike
  regular monsters, one attack call deals a single hit against a **persistent
  50,000 HP pool shared by the whole server** rather than resolving a full
  fight in one call - anyone can pile on regardless of level. A 3-second
  per-player cooldown keeps it from being spammable. When it dies, EXP/gold
  are split proportionally by damage contributed among everyone who hit it
  that generation, plus each contributor independently rolls for the
  **Kingpin's Signet** drop (15% chance, needs level 25 to equip but anyone
  can earn the drop). It respawns 3 hours after death. HP updates broadcast
  live over the socket layer to everyone standing in the room, whether
  they're attacking or just watching. A **top-10 damage leaderboard** updates
  live the same way - every hit rebroadcasts the current standings to
  everyone in the room, not just the attacker, so spectators can watch who's
  leading in real time. It's scoped per "generation" (the boss's current
  life), so it naturally resets to empty once the boss respawns, but the
  final standings stay visible for a while after a kill rather than
  vanishing the instant it dies.
- **Second world boss - The Unbound (Lv.50+):** sitting at Angelio St.'s
  entrance rather than gated inside a high-level zone, so the "anyone can
  help regardless of level" spirit stays intact even though it's tuned
  for endgame characters - roughly 4.4x the Kingpin's HP pool. Drops
  **The Unbound's Chain** (neck), deliberately picked since every
  quest-chain reward item up to this point had landed on weapon (four for
  four) - neck/shield/legs/boots had never gotten a dedicated reward.
  Fully independent from the Kingpin (separate HP pool, drop table, and
  contribution tracking) - the whole world boss system was already
  data-driven enough that adding a second one needed zero frontend changes.
- **Prestige (rebirth):** at level 50, talk to **The Rebirth Elder** (Main
  St.'s Town Square) to reset back to level 1 - keeping your gold and
  inventory, but resetting allocated stat points - in exchange for a small
  **permanent** stat bonus (+3 Attack / +15 Max HP) that stacks with every
  future rebirth. Rebirth count shows on the Character sheet. No cap on how
  many times you can do it.
- **Quests redo each rebirth:** completing a quest only marks it done for
  your *current* rebirth generation - rebirthing makes every quest you'd
  already finished acceptable again (tracked via `character_quests.
  generation`, so the historical record of past completions is never
  deleted, just no longer counted as "done" for the new generation).
  Each redo requires **+25% more kills than the last** (compounds with
  generation, not with itself), and pays proportionally more EXP/gold to
  match. Quests that reward unique gear grant a genuinely new, more
  powerful **"(Gen N)"** version of that item - not a duplicate of the
  original - created the first time it's actually earned at that
  generation and reused after that (+25% stats per generation, same
  slot/rarity/set membership as the original). Prerequisite chains must
  be redone in order each generation too - a completion from a past
  rebirth doesn't let you skip straight to a chain's finale.
- **Tower of Ascension:** a separate 1-100 leveling track, its own tab
  (not a walkable zone - there's no map for this one), unlocked once your
  character reaches level 10. Fight the current floor's guardian (one of
  four named tiers - Sentinel, Warden, Reaper, Titan - purely for flavor,
  since the actual stats are 100% formula-driven from the floor number, not
  hand-tuned) to earn **Tower EXP**, using its own curve (`60 * floor^1.45`)
  deliberately separate from character leveling. Every 10 floors grants a
  small **permanent** stat bonus (+1 Attack / +5 Max HP, capping at +10/+50
  for fully climbing to floor 100) that's baked into your stats everywhere,
  not just here - and critically, **survives rebirth**: rebirth only
  touches `level`/`exp`/`attack_points`/`hp_points`, never `tower_level` or
  `tower_exp`. One real interaction worth knowing: since rebirth resets
  character level to 1 and the Tower requires level 10, rebirthing
  temporarily locks you out of the Tower tab until you level back up -
  your floor progress and earned bonuses aren't lost, just inaccessible
  for a few levels. Tower monster rewards are pegged to cost exactly 25
  kills per floor for all 100 floors (`exp_reward = floorExpNeeded / 25`),
  same self-consistent formula approach used to fix the main reward curve
  - no boss cliffs, just a steady, predictable long-haul grind.
- **Crafting (The Blacksmith):** three full 8-piece gear sets - Forged
  (Lv.15), Runic (Lv.30), Voidforged (Lv.45) - one piece per equipment
  slot per tier, 24 items total. Monsters in the appropriate zones (tier
  15 → Angelio St./City Hospital, tier 30 → Underworks/Blacksite/
  Docklands, tier 45 → The Zhul Breach) drop **slot-specific crafting
  materials**, not the finished gear directly - Talk to **The Blacksmith**
  (Main St.'s Town Square, alongside the Rebirth Elder) to spend materials
  + gold crafting the exact piece you're missing, rather than hoping
  for the right drop out of 8 possibilities. Materials stack (a separate
  `character_materials` table, since regular equipment is one row per
  instance and was never built to stack). Item stats and material/gold
  costs are 100% formula-driven from tier level, not hand-picked per item -
  same consistency approach as the reward-rebalancing fix. Deliberately
  capped below the unique dungeon/boss-exclusive rewards (like Zhul's
  Blessing) even at a full 8-piece set, so crafting is a strong, reliable
  path to gear rather than a replacement for the one-off legendary chase
  items.
- **Marketplace:** a player-to-player auction house (its own tab), not
  direct trading - list equipment or crafting materials for a gold price,
  anyone can buy anytime without needing to coordinate being online
  together. Every item is tradeable, including the unique dungeon/boss
  rewards - the market decides value rather than the game excluding
  anything. Takes a **10% cut** from the seller's proceeds on every sale
  (a genuine gold sink - the cut leaves the economy, it isn't paid to
  anyone). Listing equipment **deletes the row from `character_inventory`
  entirely** rather than adding an "escrowed" flag - the item's
  `item_template_id`/`upgrade_level` are snapshotted onto the listing, and
  a fresh inventory row is created for whoever ends up with it (buyer, or
  the original seller if cancelled/expired). This was a deliberate choice
  so every existing inventory/equip/upgrade/sell query stays correct
  without needing to be individually audited for an "is this escrowed"
  check - a listed item just doesn't exist in that table until it's
  resolved. Unsold listings auto-expire after 72 hours (checked lazily on
  read, same respawn-style pattern used elsewhere, no background job).
- **Inventory & equipment:** a paper-doll view — weapon/chest/head/boots/neck/
  shield/hands/legs slots arranged around a character silhouette, click a
  filled slot to unequip — plus an Attack/HP stats summary, and a full item
  list below for equipping anything you own. The list has **subtabs by slot**
  and a **sort dropdown** (rarity/level/name/slot), and every unequipped item
  automatically shows a **comparison against whatever you have equipped**
  (`vs equipped: +8 ATK / -3 HP`, color-coded) — same comparison shows up in
  the Shop too, so you can tell if a purchase is actually an upgrade before
  spending gold. Every non-quest item can be **sold for 50% of its original
  shop price**; quest items can be **discarded** for free. Both ask for
  confirmation first. A star toggle **protects** an item from **Sell All
  Common**, a one-click bulk-salvage button that sells every unequipped,
  unprotected Common item at once.
- **Item rarity:** every item is common/uncommon/rare/epic/legendary/mythic,
  color-coded in the UI (name text + a left border on the row). Assigned by
  level/source tier rather than randomly rolled, since gear here is
  template-based rather than procedurally generated loot.
- **Set bonuses:** two sets exist — the **Bounty Hunter Set** (Neck/Vest/
  Boots, shop-purchasable) and **Warden's Regalia** (Cleaver/Plate/Grip,
  dungeon-exclusive - the Grip is a 30% bonus drop from The Warden). Each
  grants a bonus at 2 pieces equipped and a bigger one at the full 3. Active
  set bonuses show on the Inventory tab below the paper-doll.
- **Gear upgrading (+0 to +5):** risk-based enhancement, costs gold up front
  regardless of outcome. +1/+2 are safe (a failed attempt just wastes the
  gold); +3 and above carry a real chance the item is destroyed on failure.
  Success chance and cost both get harder/pricier at higher levels. The
  Upgrade button shows the exact cost, success chance, and risk before you
  confirm.
- **Shop:** 26 items spanning levels 1-30, covering every equipment slot
  (weapon/chest/head/boots/hands/legs/shield/neck), organized into subtabs
  by slot so you're not scrolling through everything at once. Only shows
  `source: 'shop'` items — dungeon
  and quest-exclusive gear never appears here.
- **Clans:** create or join a clan, see the roster.
- **Leaderboard:** ranks all characters by level/EXP.
- **Artwork:** monsters, items, and zones use real icon art (not placeholder
  emoji) — 52 SVG icons pulled from [game-icons.net](https://game-icons.net)
  via their open-source GitHub repo, recolored to the game's gold accent and
  wired into the room view, monster list, inventory, shop, and paper-doll.
  Licensed CC BY 3.0 — see `public/images/ATTRIBUTIONS.md` for the per-icon
  author credit (also linked in-app at the bottom of the sidebar). The
  `image` fields in `server/db/seed.js` are just string slugs, so swapping in
  different art later is a drop-in replacement.
- **News:** a News tab everyone can see, with a small unread-indicator dot
  that appears when there's a post since your last visit and clears the
  moment you open the tab. Admins get a posting form right on the same tab
  (title, body, and a color-coded category - Update/Event/Maintenance) plus
  a delete button on each post. One-way only by design - no comments or
  reactions, just admin-to-player announcements.
- **Admin panel:** an Admin tab (visible only to accounts with `is_admin`)
  with live server stats (accounts, characters, level spread, total gold,
  world boss status) and a searchable player list. From there you can ban
  (blocks login immediately **and** cuts off any currently-active session,
  not just future ones), unban, or permanently delete an account - deleting
  cleans up their inventory, quests, and combat history with no orphaned
  rows, though chat messages are kept since they already store the sender's
  name as plain text and don't need the account to still exist. There's no
  UI to grant the *first* admin (nothing to click before one exists) - run
  `npm run make-admin <username>` once, locally or via Render's Shell tab
  against production, to bootstrap it.
- **Player profiles:** click any player's name - in chat, in the "also
  here" list when you share a room, or on the leaderboard - to open a
  read-only profile: level, clan, Attack/Max HP, active set bonuses, and
  their equipped gear (hover any piece for the same stat tooltip used on
  your own paper-doll). Deliberately excludes gold and unequipped inventory
  - a profile shows what someone's wearing, not their wallet.
- **New player tutorial:** a guided, interactive walkthrough shown on first
  login - move to a room, win a fight, accept a quest, equip gear - that
  waits for each *real* action rather than just clicking through slides. A
  pulsing highlight points at the exact UI element for the current step. A
  starter weapon is granted when the tutorial begins (so there's something
  to equip in the last step), and finishing for real grants a 150 gold
  bonus; skipping (available at any point) does not. Progress is tracked
  server-side on the character (`tutorial_step`, 0-5), so it survives
  across devices and never re-shows once finished.
- **Other players visible in your room:** if someone else is standing in the
  same room, you'll see their name and level.

## Project structure

```
outwar-clone/
  server/
    index.js          - Express app entry point
    middleware.js      - auth/character guards
    gameLogic.js        - leveling curve + combat resolution formulas
    db/
      db.js             - schema (users, characters, zones, rooms, monsters, items, clans...)
      seed.js            - populates the world (safe to re-run, skips if already seeded)
    routes/
      auth.js            - register/login/logout/me
      character.js        - character creation, stat allocation
      world.js             - room details, movement between rooms
      combat.js             - attack resolution
      inventory.js           - inventory, equip/unequip, shop, buy
      leaderboard.js          - rankings
      clans.js                 - create/join/leave/roster
  public/
    index.html          - single-page app shell
    css/style.css        - dark/gold "underworld" visual theme
    js/app.js              - all frontend logic (fetch calls + DOM rendering)
```

## Real-time layer (Socket.IO)

`server/socket.js` runs a Socket.IO server alongside the REST API, sharing
the same `express-session` middleware — sockets are authenticated via your
existing login cookie, not anything the client claims, so there's no way to
spoof another character's identity over the socket connection.

- **Live room presence:** when you move (via the existing REST move/teleport
  endpoints), the client emits `room_changed`; the server re-reads your
  actual room from the DB and broadcasts an updated player list to everyone
  in both the old and new room. No polling involved.
- **Global chat + clan chat:** a chat widget is docked bottom-right in the
  game screen (collapsible). Messages persist to the `chat_messages` table so
  reconnecting shows recent history instead of an empty log. Clan chat only
  works if you're in a clan; the client blocks sending otherwise, and the
  server double-checks clan membership before broadcasting too.

If you deploy behind a reverse proxy (nginx, etc.), make sure WebSocket
upgrade headers are passed through, or Socket.IO will silently fall back to
HTTP long-polling.

## Deploying for real (multiple concurrent players)

Running this locally is fine for one person, but for a real shared world you need a host
that gives you a **persistent Node.js process** (for Socket.IO), **persistent disk
storage** (for the SQLite file), and proper **WebSocket passthrough**. That rules out most
serverless/static hosts (Vercel, Cloudflare Pages, etc.) - this needs a "real server," even
a small one.

Two environment variables control where production data lives, so it survives redeploys:

- `DB_PATH` - full path to the SQLite file (e.g. `/var/data/game.db`). Without this, the
  database lives next to `server/db/db.js`, which is fine locally but gets wiped on most
  hosts' redeploys since only an explicitly-attached disk persists.
- `SESSIONS_PATH` - folder for session files (e.g. `/var/data/sessions`). Sessions are
  stored as files (via `session-file-store`), not in memory, specifically so a server
  restart or redeploy doesn't log every player out - only losing the disk they're on would.
- `SESSION_SECRET` - any random string; secures session cookies. Set this in production
  instead of relying on the built-in dev default.

Point both `DB_PATH` and `SESSIONS_PATH` at the same persistent disk.

### Recommended host: Render (paid Starter plan + a persistent disk)

Render's free tier does **not** support attaching a
persistent disk, so it's not viable for a real shared database. The paid Starter plan
(~$7/month at the time of writing - check Render's current pricing) does:

1. In your Render dashboard, open your Web Service → **Settings** → upgrade the instance
   type from Free to Starter.
2. Still in Settings, find **Disks** → **Add Disk**. Give it a name, a mount path like
   `/var/data`, and a small size (1GB is enormous overkill for a SQLite file like this).
3. Under **Environment**, add:
   - `DB_PATH` = `/var/data/game.db`
   - `SESSIONS_PATH` = `/var/data/sessions`
   - `SESSION_SECRET` = (generate any random string)
4. Redeploy. From now on, your data lives on that disk and survives restarts/redeploys.

(Railway and Fly.io both work too and support the same persistent-volume idea - Fly.io no
longer has a free tier as of mid-2026, and requires a Dockerfile, so Render or Railway are
the simpler starting points if you haven't containerized before.)

### The ongoing workflow for shipping new features

Once deployed this way, adding new features going forward is just:

1. Get the updated files (same as before - copy them into your local project folder).
2. In your terminal, inside the project folder:
   ```cmd
   git add .
   git commit -m "describe what changed"
   git push
   ```
3. Render (or Railway) is watching your GitHub repo and automatically redeploys on every
   push - no manual redeploy step needed.
4. If a change includes a schema update, you'll be told to run `npm run reset-db` — but
   running that against your **production** `DB_PATH` wipes every real player's character,
   so treat it as a last resort in production, not a routine step like in local dev.

## Roadmap / what to build next

This covers a lot of depth now, but there's more Outwar has that isn't here
yet. Natural next additions, roughly in order of how easy they'd be to bolt on:

1. **Quest turn-in NPCs** — right now quests auto-complete the instant
   progress hits the target. A more authentic feel would have you return to
   an NPC to turn them in manually (matches the original's "Quest Helper"
   flow more closely).
2. **PvP** — let characters attack each other instead of only monsters; needs
   rules around HP loss, cooldowns, and probably a "safe zone" flag on rooms.
3. **More dungeons** — the quest-chain-with-exclusive-reward pattern used for
   The Underworks is generalized (`prerequisite_quest_id`, `source: 'dungeon'`
   items), so adding a second dungeon is mostly just seed data.
4. ~~Real-time presence~~ — done, see below (room presence + chat are live via
   Socket.IO now; the leaderboard and monster respawn countdowns still poll
   on next fetch, so making those live too is a natural next step).
5. ~~Auto-attacker / idle combat~~ — done, see below.
6. ~~Artwork~~ — done, see below.
7. ~~World bosses~~ — done, see below.

## Swapping the database (if you're on an older Node version)

If you can't upgrade past Node 22.5, replace `server/db/db.js`'s use of
`node:sqlite` with `better-sqlite3` (`npm install better-sqlite3` — this one
does require native compilation, so you'll need build tools installed) or
`sql.js`. The rest of the codebase uses the same `db.prepare(...).get()/.run()/.all()`
pattern that `better-sqlite3` also implements, so the swap should be limited to
that one file.
