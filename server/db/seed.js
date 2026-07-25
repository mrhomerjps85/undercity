// seed.js - Populates the world with zones, rooms, monsters, items, drops, and quests.
// Safe to re-run: it checks if data already exists before inserting.
// Run `npm run reset-db` any time you want to wipe and reseed from scratch.
const db = require('./db');

function alreadySeeded() {
  const row = db.prepare('SELECT COUNT(*) as c FROM zones').get();
  return row.c > 0;
}

// Procedurally generates a size x size grid of room names from adjective/noun word banks,
// so we don't have to hand-author 80+ unique names per zone. entranceCoord gets a fixed name.
function generateRoomNameGrid(size, entranceCoord, entranceName, adjectives, nouns) {
  const combos = [];
  for (const a of adjectives) {
    for (const n of nouns) {
      combos.push(`${a} ${n}`);
    }
  }
  const used = new Set([entranceName]);
  let comboIndex = 0;
  const nextUniqueName = () => {
    let name;
    let safety = 0;
    do {
      name = combos[comboIndex % combos.length];
      if (comboIndex >= combos.length) {
        // Wrapped around once - append a suffix to guarantee uniqueness.
        name = `${name} ${Math.floor(comboIndex / combos.length) + 1}`;
      }
      comboIndex++;
      safety++;
    } while (used.has(name) && safety < combos.length * 3);
    used.add(name);
    return name;
  };

  const grid = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) {
      if (entranceCoord[0] === x && entranceCoord[1] === y) {
        row.push(entranceName);
      } else {
        row.push(nextUniqueName());
      }
    }
    grid.push(row);
  }
  return grid;
}

function seed() {
  // Every insert below is idempotent (upsert-by-name, or an existence check first) - see
  // the "Unique indexes" comment in db.js. That means seed() is now safe to run in full on
  // every server start, not just once: existing zones/monsters/items/quests are left
  // untouched, and anything newly added to this file (like a new zone) gets backfilled
  // into an already-live database automatically, without ever needing `npm run reset-db`.
  const wasAlreadySeeded = alreadySeeded();
  console.log(wasAlreadySeeded ? 'World already seeded - checking for new content to add...' : 'Seeding world data...');

  const GRID_SIZE = 9;

  // ---------------------------------------------------------------------
  // ZONES - min_level requirements kept low so zones (and their quest lines)
  // are reachable earlier; the higher-level content inside still gates via
  // individual quest/monster levels.
  // ---------------------------------------------------------------------
  const insertZone = db.prepare(`
    INSERT INTO zones (name, description, min_level, image, is_dungeon) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET name=excluded.name RETURNING id
  `);
  const zoneMainSt = insertZone.get('Main St.', 'The beating heart of the city. Everyone starts here.', 1, 'street', 0).id;
  const zoneAngelio = insertZone.get('Angelio St.', 'A rougher part of town, thick with gang activity.', 5, 'street_night', 0).id;
  const zoneHospital = insertZone.get('City Hospital', 'Something is very wrong in the emergency ward.', 8, 'hospital', 0).id;
  const zoneUnderworks = insertZone.get('The Underworks', 'A flooded sewer complex beneath the city. Something ancient rules down here.', 12, 'sewer', 1).id;
  const zoneBlacksite = insertZone.get('The Blacksite', 'An off-the-books corporate research facility. Whatever they were building here, it got loose.', 18, 'blacksite', 1).id;
  const zoneDocklands = insertZone.get('The Docklands', "Organized crime runs the shipping yards now. Cargo comes in, and sometimes people don't go back out.", 24, 'docklands', 1).id;
  const zoneZhulBreach = insertZone.get('The Zhul Breach', "A tear in reality itself has opened beneath the city. Something ancient is pushing through from the other side.", 35, 'zhul_breach', 1).id;

  // ---------------------------------------------------------------------
  // ROOMS - each zone is now a 9x9 grid (81 rooms). Names are generated from
  // themed word banks; a handful of key rooms (entrance, boss lair) keep fixed names.
  // ---------------------------------------------------------------------
  const insertRoom = db.prepare(`INSERT INTO rooms (zone_id, name, grid_x, grid_y, image, is_entrance) VALUES (?, ?, ?, ?, ?, ?)`);
  const linkRoom = db.prepare(`UPDATE rooms SET north_room_id=?, south_room_id=?, east_room_id=?, west_room_id=? WHERE id=?`);

  function buildGrid(zoneId, roomNames, imageBase, entranceCoord) {
    const size = roomNames.length;
    const ids = {};

    // If this zone's rooms already exist (from an earlier run against this database),
    // reuse them instead of inserting duplicates - this is what makes it safe to call
    // buildGrid() on every server start, not just once against a brand-new database.
    const existingCount = db.prepare('SELECT COUNT(*) c FROM rooms WHERE zone_id = ?').get(zoneId).c;
    if (existingCount > 0) {
      db.prepare('SELECT id, grid_x, grid_y FROM rooms WHERE zone_id = ?').all(zoneId)
        .forEach((r) => { ids[`${r.grid_x},${r.grid_y}`] = r.id; });
      return ids;
    }

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < roomNames[y].length; x++) {
        const name = roomNames[y][x];
        if (!name) continue;
        const isEntrance = entranceCoord && entranceCoord[0] === x && entranceCoord[1] === y ? 1 : 0;
        const id = insertRoom.run(zoneId, name, x, y, `${imageBase}_${x}_${y}`, isEntrance).lastInsertRowid;
        ids[`${x},${y}`] = id;
      }
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < roomNames[y].length; x++) {
        const id = ids[`${x},${y}`];
        if (!id) continue;
        const north = ids[`${x},${y - 1}`] || null;
        const south = ids[`${x},${y + 1}`] || null;
        const east = ids[`${x + 1},${y}`] || null;
        const west = ids[`${x - 1},${y}`] || null;
        linkRoom.run(north, south, east, west, id);
      }
    }
    return ids;
  }

  const mainStEntrance = [4, 4];
  const mainStNames = generateRoomNameGrid(GRID_SIZE, mainStEntrance, 'Town Square',
    ['North', 'South', 'East', 'West', 'Old', 'New', 'Lower', 'Upper', 'Central', 'Grand', 'Back', 'Side', 'Quiet', 'Busy', 'Narrow', 'Wide', 'Forgotten', 'Rusty', 'Hidden', 'Broken'],
    ['Avenue', 'Street', 'Alley', 'Plaza', 'Market', 'Lot', 'Yard', 'Dock', 'Depot', 'Crossing', 'Block', 'Corner', 'Row', 'Path', 'Junction', 'Square', 'Bridge', 'Tunnel', 'Garage', 'Warehouse']
  );
  const mainStGrid = buildGrid(zoneMainSt, mainStNames, 'mainst', mainStEntrance);

  const angelioEntrance = [4, 1];
  const angelioNames = generateRoomNameGrid(GRID_SIZE, angelioEntrance, 'Angelio St.',
    ['Broken', 'Burnt', 'Rusted', 'Shadow', 'Silent', 'Bloody', 'Iron', 'Concrete', 'Forgotten', 'Twisted', 'Grim', 'Dark', 'Cracked', 'Rotten', 'Sunken', 'Scorched', 'Hollow', 'Savage', 'Wired', 'Dead'],
    ['Block', 'Alley', 'Turf', 'Corner', 'Yard', 'Lot', 'Row', 'Den', 'Hideout', 'Warehouse', 'Garage', 'Dock', 'Junkyard', 'Rooftop', 'Overpass', 'Underpass', 'Checkpoint', 'Safehouse', 'Compound', 'Lookout']
  );
  const angelioGrid = buildGrid(zoneAngelio, angelioNames, 'angelio', angelioEntrance);

  const hospitalEntrance = [4, 1];
  const hospitalNames = generateRoomNameGrid(GRID_SIZE, hospitalEntrance, 'Emergency Room',
    ['East', 'West', 'North', 'South', 'Upper', 'Lower', 'Sterile', 'Quarantined', 'Abandoned', 'Sealed', 'Cold', 'Silent', 'Restricted', 'Contaminated', 'Isolated', 'Dim', 'Flooded', 'Locked', 'Dark', 'Cracked'],
    ['Ward', 'Wing', 'Corridor', 'Chamber', 'Lab', 'Vault', 'Storage', 'Unit', 'Bay', 'Annex', 'Cell', 'Hall', 'Station', 'Passage', 'Suite', 'Block', 'Sector', 'Theater', 'Clinic', 'Morgue']
  );
  const hospitalGrid = buildGrid(zoneHospital, hospitalNames, 'hospital', hospitalEntrance);

  const underworksEntranceCoord = [4, 1];
  const underworksNames = generateRoomNameGrid(GRID_SIZE, underworksEntranceCoord, 'Underworks Entrance',
    ['Flooded', 'Collapsed', 'Rusted', 'Bone', 'Forgotten', 'Dripping', 'Cursed', 'Sunken', 'Broken', 'Hollow', 'Twisted', 'Buried', 'Rotting', 'Silent', 'Drowned', 'Ancient', 'Fetid', 'Crumbling', 'Slimy', 'Echoing'],
    ['Tunnel', 'Passage', 'Chamber', 'Catwalk', 'Grate', 'Pit', 'Vault', 'Cistern', 'Drain', 'Culvert', 'Hollow', 'Cavern', 'Shaft', 'Corridor', 'Den', 'Nest', 'Crypt', 'Trench', 'Gallery', 'Warren']
  );
  // Fix a specific room as the boss lair, deep in the grid away from the entrance.
  underworksNames[7][4] = "The Warden's Lair";
  const underworksGrid = buildGrid(zoneUnderworks, underworksNames, 'underworks', underworksEntranceCoord);

  const blacksiteEntranceCoord = [4, 1];
  const blacksiteNames = generateRoomNameGrid(GRID_SIZE, blacksiteEntranceCoord, 'Blacksite Entrance',
    ['Sealed', 'Restricted', 'Sterile', 'Classified', 'Automated', 'Reinforced', 'Silent', 'Abandoned', 'Encrypted', 'Sub-level', 'Quarantined', 'Cold', 'Dim', 'Locked', 'Server', 'Contained', 'Fractured', 'Overridden', 'Failed', 'Experimental'],
    ['Wing', 'Lab', 'Corridor', 'Vault', 'Bay', 'Terminal', 'Chamber', 'Annex', 'Server Room', 'Containment Cell', 'Reactor Room', 'Data Vault', 'Checkpoint', 'Hangar', 'Sector', 'Loading Dock', 'Observation Deck', 'Testing Floor', 'Archive', 'Control Room']
  );
  blacksiteNames[7][4] = "The Overseer's Chamber";
  const blacksiteGrid = buildGrid(zoneBlacksite, blacksiteNames, 'blacksite', blacksiteEntranceCoord);

  const docklandsEntranceCoord = [4, 1];
  const docklandsNames = generateRoomNameGrid(GRID_SIZE, docklandsEntranceCoord, 'Pier Entrance',
    ['Rusted', 'Foggy', 'Silent', 'Flooded', 'Abandoned', 'Guarded', 'Restricted', 'Salt-Worn', 'Crumbling', 'Overgrown', 'Locked', 'Watched', 'Sunken', 'Windswept', 'Sealed', 'Forgotten', 'Barred', 'Tide-Worn', 'Shadowed', 'Corroded'],
    ['Pier', 'Warehouse', 'Loading Dock', 'Cargo Bay', 'Container Yard', 'Berth', 'Quay', 'Gantry', 'Freight Hall', 'Drydock', 'Shipping Lane', 'Crane Yard', 'Wharf', 'Storage Hold', 'Customs House', 'Harbor Office', 'Fuel Depot', 'Scrapyard', 'Breakwater', 'Anchorage']
  );
  docklandsNames[7][4] = "Kane's Warehouse";
  const docklandsGrid = buildGrid(zoneDocklands, docklandsNames, 'docklands', docklandsEntranceCoord);

  const zhulBreachEntranceCoord = [4, 1];
  const zhulBreachNames = generateRoomNameGrid(GRID_SIZE, zhulBreachEntranceCoord, 'The Breach Threshold',
    ['Shattered', 'Warped', 'Bleeding', 'Screaming', 'Twisted', 'Endless', 'Silent', 'Burning', 'Frozen', 'Writhing', 'Hollow', 'Whispering', 'Fractured', 'Drifting', 'Unstable', 'Consumed', 'Forsaken', 'Trembling', 'Withering', 'Boundless'],
    ['Rift', 'Expanse', 'Chasm', 'Threshold', 'Hollow', 'Passage', 'Nexus', 'Void', 'Scar', 'Breach', 'Corridor', 'Sanctum', 'Abyss', 'Fracture', 'Wound', 'Gate', 'Depths', 'Veil', 'Echo', 'Rupture']
  );
  zhulBreachNames[7][4] = "The Devourer's Maw";
  const zhulBreachGrid = buildGrid(zoneZhulBreach, zhulBreachNames, 'zhulbreach', zhulBreachEntranceCoord);

  // ---------------------------------------------------------------------
  // MONSTER TEMPLATES
  // ---------------------------------------------------------------------
  const insertMonster = db.prepare(`
    INSERT INTO monster_templates (name, level, max_hp, attack, defense, exp_reward, gold_reward, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET name=excluded.name RETURNING id
  `);
  const m = {};

  // Main St. (levels 1-9)
  m.sewerRatPack = insertMonster.get('Sewer Rat Pack', 1, 25, 2, 0, 12, 5, 'rats').id;
  m.streetThief = insertMonster.get('Street Thief', 2, 40, 4, 1, 25, 10, 'thief').id;
  m.brassPunk = insertMonster.get('Brass Knuckle Punk', 3, 48, 5, 1, 32, 14, 'punk').id;
  m.thug = insertMonster.get('Back-Alley Thug', 3, 55, 6, 2, 35, 15, 'thug').id;
  m.dockWorker = insertMonster.get('Rogue Dock Worker', 4, 70, 7, 2, 45, 20, 'dockworker').id;
  m.scavenger = insertMonster.get('Scrapyard Scavenger', 5, 82, 8, 2, 55, 25, 'scavenger').id;
  m.brawler = insertMonster.get('Bus Depot Brawler', 6, 95, 9, 3, 65, 30, 'brawler').id;
  m.lurker = insertMonster.get('Storm Drain Lurker', 7, 108, 10, 3, 75, 35, 'lurker').id;
  m.constructionGoon = insertMonster.get('Construction Goon', 8, 120, 11, 4, 85, 40, 'goon').id;
  m.mugger = insertMonster.get('Underpass Mugger', 9, 132, 12, 4, 95, 45, 'mugger').id;

  // Angelio St. (levels 10-19)
  m.cornerDealer = insertMonster.get('Corner Dealer', 10, 145, 13, 4, 105, 50, 'dealer').id;
  m.ganglordSid = insertMonster.get('Ganglord Sid', 12, 220, 16, 6, 180, 90, 'ganglord').id;
  m.mechanic = insertMonster.get('Chop Shop Mechanic', 11, 160, 14, 5, 115, 55, 'mechanic').id;
  m.safehouseGuard = insertMonster.get('Safehouse Guard', 13, 190, 17, 6, 135, 65, 'guard').id;
  m.smuggler = insertMonster.get('Weapons Smuggler', 14, 205, 18, 6, 150, 72, 'smuggler').id;
  m.sniper = insertMonster.get('Lookout Sniper', 15, 215, 19, 7, 160, 78, 'sniper').id;
  m.dogHandler = insertMonster.get('Junkyard Dog Handler', 16, 228, 20, 7, 170, 84, 'doghandler').id;
  m.foreman = insertMonster.get('Factory Foreman', 17, 240, 21, 8, 180, 90, 'foreman').id;
  m.borderThug = insertMonster.get('Border Thug', 18, 252, 22, 8, 190, 96, 'borderthug').id;
  m.captain = insertMonster.get('Smuggler Captain', 19, 265, 23, 9, 200, 102, 'captain').id;

  // City Hospital (levels 15-24)
  m.vileSurgeon = insertMonster.get('Vile Surgeon', 15, 300, 20, 8, 260, 130, 'surgeon').id;
  m.morgueCrawler = insertMonster.get('Morgue Crawler', 17, 240, 21, 8, 180, 90, 'crawler').id;
  m.nurseWraith = insertMonster.get('Nurse Wraith', 16, 228, 20, 7, 170, 84, 'wraith').id;
  m.ambulanceDriver = insertMonster.get('Ambulance Driver', 18, 260, 18, 7, 220, 110, 'driver').id;
  m.labMutant = insertMonster.get('Lab Mutant', 19, 270, 24, 9, 210, 105, 'mutant').id;
  m.witheredRavager = insertMonster.get('Withered Ravager', 20, 400, 26, 10, 340, 170, 'ravager').id;
  m.bloodBankLeech = insertMonster.get('Blood Bank Leech', 20, 320, 25, 9, 300, 150, 'leech').id;
  m.incineratorFiend = insertMonster.get('Incinerator Fiend', 21, 340, 27, 10, 320, 160, 'fiend').id;
  m.quarantineHorror = insertMonster.get('Quarantine Horror', 22, 360, 28, 11, 340, 170, 'horror').id;
  m.containmentBreach = insertMonster.get('Containment Breach', 23, 380, 29, 11, 360, 180, 'breach').id;

  // The Underworks (dungeon, levels 22-30)
  m.underworksGrunt = insertMonster.get('Underworks Grunt', 22, 350, 27, 10, 250, 120, 'grunt').id;
  m.underworksEnforcer = insertMonster.get('Underworks Enforcer', 25, 420, 32, 13, 320, 160, 'enforcer').id;
  m.sewerAbomination = insertMonster.get('Sewer Abomination', 27, 480, 36, 14, 400, 200, 'abomination').id;
  m.theWarden = insertMonster.get('The Warden', 30, 900, 45, 18, 1200, 600, 'warden').id;

  // Extra monster variety, spread across zones and levels (adds density + fills quest-target gaps)
  m.cutthroat = insertMonster.get('Alley Cutthroat', 2, 38, 4, 1, 24, 9, 'hooded_assassin').id;
  m.nightProwler = insertMonster.get('Night Prowler', 7, 110, 10, 3, 76, 36, 'shadow_follower').id;
  m.roofSniper = insertMonster.get('Rooftop Sniper', 9, 130, 13, 4, 96, 46, 'rifle').id;
  m.bladeRunner = insertMonster.get('Blade Runner', 11, 158, 15, 5, 112, 54, 'cloak_dagger').id;
  m.turfEnforcer = insertMonster.get('Turf Enforcer', 17, 242, 21, 8, 182, 91, 'chain_mail').id;
  m.infectedPatient = insertMonster.get('Infected Patient', 16, 230, 20, 7, 172, 85, 'virus').id;
  m.anesthesiologist = insertMonster.get('Rogue Anesthesiologist', 18, 255, 23, 8, 195, 97, 'syringe').id;
  m.escapedPatient = insertMonster.get('Escaped Patient', 21, 335, 27, 10, 330, 165, 'prisoner').id;
  m.sewerCrawler = insertMonster.get('Sewer Crawler', 23, 365, 29, 11, 255, 130, 'half_body_crawling').id;
  m.boneCollector = insertMonster.get('Bone Collector', 26, 450, 34, 13, 380, 190, 'bone_gnawer').id;

  // The Blacksite (dungeon, levels 19-28)
  m.securityDrone = insertMonster.get('Security Drone', 19, 270, 24, 9, 200, 100, 'security_drone').id;
  m.mercenary = insertMonster.get('Corporate Mercenary', 21, 335, 27, 10, 330, 165, 'mercenary').id;
  m.failedExperiment = insertMonster.get('Failed Experiment', 24, 385, 30, 12, 380, 190, 'failed_experiment').id;
  m.aiConstruct = insertMonster.get('Rogue AI Construct', 26, 460, 35, 13, 400, 200, 'ai_construct').id;
  m.theOverseer = insertMonster.get('The Overseer', 28, 950, 42, 17, 1300, 650, 'overseer').id;

  // The Docklands (levels 24-31) - fills the gap between the older dungeon caps and The
  // Zhul Breach's level-35 floor. Reward values here are placeholders (0) - db.js's
  // rebalanceMonsterRewards() recalculates every monster's exp/gold from its level right
  // after seeding, so there's no need (and no risk of drift) to hand-tune them here.
  // Dockmaster Kane is registered as a named boss in that same rebalance function.
  m.cargoSmuggler = insertMonster.get('Cargo Smuggler', 24, 390, 30, 12, 0, 0, 'cargo_smuggler').id;
  m.docksideEnforcer = insertMonster.get('Dockside Enforcer', 25, 425, 32, 13, 0, 0, 'dockside_enforcer').id;
  m.cartelLieutenant = insertMonster.get('Cartel Lieutenant', 27, 485, 36, 14, 0, 0, 'cartel_lieutenant').id;
  m.harborMaster = insertMonster.get('Corrupt Harbor Master', 29, 505, 38, 15, 0, 0, 'harbor_master').id;
  m.dockmasterKane = insertMonster.get('Dockmaster Kane', 31, 980, 47, 19, 0, 0, 'dockmaster_kane').id;

  // Deepened dungeon content - bridges the gap between the existing dungeon caps (28-30)
  // and The Zhul Breach's minimum level (35).
  m.broodmother = insertMonster.get('Underworks Broodmother', 32, 520, 40, 16, 750, 375, 'broodmother').id;
  m.overseerPrototype = insertMonster.get('Failed Overseer Prototype', 33, 560, 42, 17, 800, 400, 'overseer_prototype').id;

  // The Zhul Breach (dungeon, levels 35-50) - the game's current level cap.
  m.riftStalker = insertMonster.get('Rift Stalker', 35, 620, 47, 18, 900, 450, 'rift_stalker').id;
  m.zhulCultist = insertMonster.get('Zhul Cultist', 38, 700, 52, 20, 1100, 550, 'zhul_cultist').id;
  m.corruptedHusk = insertMonster.get('Corrupted Warden Husk', 41, 800, 58, 22, 1350, 675, 'corrupted_husk').id;
  m.voidboundHorror = insertMonster.get('Voidbound Horror', 43, 870, 62, 24, 1550, 775, 'voidbound_horror').id;
  m.zhulHerald = insertMonster.get('Zhul Herald', 46, 980, 68, 26, 1850, 925, 'zhul_herald').id;
  m.zhulDevourer = insertMonster.get('Zhul, the Devourer', 50, 3500, 95, 35, 15000, 7500, 'zhul_devourer').id;

  // ---------------------------------------------------------------------
  // SPAWN MONSTERS INTO ROOMS - spread across the larger 9x9 grids.
  // Duplicates of the same monster in one room are intentional.
  // ---------------------------------------------------------------------
  const insertRoomMonster = db.prepare('INSERT INTO room_monsters (room_id, monster_template_id) VALUES (?, ?)');
  function spawn(roomId, monsterId, count = 1) {
    if (!roomId) return;
    // room_monsters deliberately allows multiple identical rows (that's how "4 Rat Packs
    // in one room" works), so this can't use a unique-index upsert like the other tables -
    // instead, only top up to `count` if fewer than that already exist for this exact pair,
    // which makes repeat seed runs safe without ever needing a full duplicate check.
    const existing = db.prepare('SELECT COUNT(*) c FROM room_monsters WHERE room_id = ? AND monster_template_id = ?').get(roomId, monsterId).c;
    for (let i = existing; i < count; i++) insertRoomMonster.run(roomId, monsterId);
  }

  // Main St. (entrance at 4,4)
  spawn(mainStGrid['3,4'], m.sewerRatPack, 4);
  spawn(mainStGrid['3,4'], m.streetThief, 2);
  spawn(mainStGrid['5,4'], m.dockWorker, 4);
  spawn(mainStGrid['1,1'], m.brassPunk, 4);
  spawn(mainStGrid['4,2'], m.thug, 4);
  spawn(mainStGrid['7,2'], m.scavenger, 4);
  spawn(mainStGrid['4,6'], m.brawler, 4);
  spawn(mainStGrid['1,7'], m.streetThief, 4);
  spawn(mainStGrid['2,3'], m.lurker, 4);
  spawn(mainStGrid['6,6'], m.constructionGoon, 4);
  spawn(mainStGrid['7,7'], m.mugger, 4);
  spawn(mainStGrid['1,4'], m.sewerRatPack, 4);
  spawn(mainStGrid['8,1'], m.brassPunk, 2);
  spawn(mainStGrid['0,0'], m.streetThief, 2);
  spawn(mainStGrid['8,8'], m.mugger, 4);
  spawn(mainStGrid['0,2'], m.scavenger, 4);
  spawn(mainStGrid['6,1'], m.brawler, 4);
  spawn(mainStGrid['3,6'], m.nightProwler, 4);
  spawn(mainStGrid['5,0'], m.constructionGoon, 4);
  spawn(mainStGrid['0,6'], m.roofSniper, 4);
  spawn(mainStGrid['6,8'], m.mugger, 4);
  spawn(mainStGrid['2,0'], m.cutthroat, 4);
  spawn(mainStGrid['8,3'], m.lurker, 4);

  // Angelio St. (entrance at 4,1)
  spawn(angelioGrid['4,1'], m.cornerDealer, 2);
  spawn(angelioGrid['4,3'], m.ganglordSid, 1); // guards the path deeper into the turf
  spawn(angelioGrid['2,2'], m.mechanic, 4);
  spawn(angelioGrid['6,2'], m.safehouseGuard, 4);
  spawn(angelioGrid['2,5'], m.smuggler, 4);
  spawn(angelioGrid['7,5'], m.sniper, 2);
  spawn(angelioGrid['4,6'], m.dogHandler, 4);
  spawn(angelioGrid['1,7'], m.foreman, 4);
  spawn(angelioGrid['7,7'], m.borderThug, 4);
  spawn(angelioGrid['5,8'], m.captain, 2);
  spawn(angelioGrid['0,4'], m.cornerDealer, 4);
  spawn(angelioGrid['8,3'], m.smuggler, 2);
  spawn(angelioGrid['0,1'], m.cornerDealer, 4);
  spawn(angelioGrid['6,0'], m.bladeRunner, 4);
  spawn(angelioGrid['1,3'], m.mechanic, 4);
  spawn(angelioGrid['8,5'], m.safehouseGuard, 4);
  spawn(angelioGrid['3,7'], m.smuggler, 4);
  spawn(angelioGrid['0,8'], m.turfEnforcer, 4);
  spawn(angelioGrid['5,3'], m.sniper, 2);

  // City Hospital (entrance at 4,1)
  spawn(hospitalGrid['1,2'], m.vileSurgeon, 4);
  spawn(hospitalGrid['7,1'], m.morgueCrawler, 4);
  spawn(hospitalGrid['4,3'], m.nurseWraith, 4);
  spawn(hospitalGrid['2,0'], m.ambulanceDriver, 4);
  spawn(hospitalGrid['6,4'], m.labMutant, 4);
  spawn(hospitalGrid['1,7'], m.witheredRavager, 4);
  spawn(hospitalGrid['5,6'], m.bloodBankLeech, 4);
  spawn(hospitalGrid['7,7'], m.incineratorFiend, 4);
  spawn(hospitalGrid['3,8'], m.quarantineHorror, 4);
  spawn(hospitalGrid['8,8'], m.containmentBreach, 2);
  spawn(hospitalGrid['0,5'], m.morgueCrawler, 4);
  spawn(hospitalGrid['3,1'], m.vileSurgeon, 4);
  spawn(hospitalGrid['0,3'], m.infectedPatient, 4);
  spawn(hospitalGrid['8,2'], m.anesthesiologist, 4);
  spawn(hospitalGrid['2,6'], m.escapedPatient, 4);
  spawn(hospitalGrid['6,7'], m.nurseWraith, 4);

  // The Underworks (dungeon, entrance at 4,1; boss lair at 4,7)
  spawn(underworksGrid['3,2'], m.underworksGrunt, 6);
  spawn(underworksGrid['5,2'], m.underworksGrunt, 6);
  spawn(underworksGrid['2,4'], m.underworksGrunt, 4);
  spawn(underworksGrid['6,4'], m.underworksEnforcer, 4);
  spawn(underworksGrid['4,5'], m.underworksEnforcer, 4);
  spawn(underworksGrid['2,6'], m.sewerAbomination, 4);
  spawn(underworksGrid['6,6'], m.sewerAbomination, 4);
  spawn(underworksGrid['4,7'] /* The Warden's Lair */, m.theWarden, 1);
  spawn(underworksGrid['1,4'], m.sewerCrawler, 4);
  spawn(underworksGrid['7,4'], m.boneCollector, 4);
  spawn(underworksGrid['3,6'], m.underworksGrunt, 4);

  // The Docklands (entrance at 4,1; boss at 4,7 - Kane's Warehouse)
  spawn(docklandsGrid['3,2'], m.cargoSmuggler, 3);
  spawn(docklandsGrid['5,2'], m.cargoSmuggler, 3);
  spawn(docklandsGrid['2,3'], m.docksideEnforcer, 3);
  spawn(docklandsGrid['6,3'], m.docksideEnforcer, 3);
  spawn(docklandsGrid['2,5'], m.cartelLieutenant, 2);
  spawn(docklandsGrid['6,5'], m.cartelLieutenant, 2);
  spawn(docklandsGrid['4,4'], m.harborMaster, 2);
  spawn(docklandsGrid['4,6'], m.harborMaster, 2);
  spawn(docklandsGrid['4,7'] /* Kane's Warehouse */, m.dockmasterKane, 1);
  spawn(underworksGrid['5,6'], m.broodmother, 3);
  spawn(underworksGrid['2,2'], m.broodmother, 3);

  // The Blacksite (entrance at 4,1; Overseer's Chamber at 4,7)
  spawn(blacksiteGrid['3,2'], m.securityDrone, 3);
  spawn(blacksiteGrid['5,2'], m.securityDrone, 3);
  spawn(blacksiteGrid['2,3'], m.mercenary, 3);
  spawn(blacksiteGrid['6,3'], m.mercenary, 3);
  spawn(blacksiteGrid['2,5'], m.failedExperiment, 2);
  spawn(blacksiteGrid['6,5'], m.failedExperiment, 2);
  spawn(blacksiteGrid['4,4'], m.aiConstruct, 2);
  spawn(blacksiteGrid['4,6'], m.aiConstruct, 2);
  spawn(blacksiteGrid['4,7'] /* The Overseer's Chamber */, m.theOverseer, 1);
  spawn(blacksiteGrid['2,7'], m.overseerPrototype, 3);
  spawn(blacksiteGrid['6,7'], m.overseerPrototype, 3);

  // The Zhul Breach (dungeon, entrance at 4,1; final boss at 4,7 - The Devourer's Maw)
  spawn(zhulBreachGrid['3,2'], m.riftStalker, 3);
  spawn(zhulBreachGrid['5,2'], m.riftStalker, 3);
  spawn(zhulBreachGrid['2,3'], m.zhulCultist, 3);
  spawn(zhulBreachGrid['6,3'], m.zhulCultist, 3);
  spawn(zhulBreachGrid['2,5'], m.corruptedHusk, 2);
  spawn(zhulBreachGrid['6,5'], m.corruptedHusk, 2);
  spawn(zhulBreachGrid['4,4'], m.voidboundHorror, 2);
  spawn(zhulBreachGrid['4,6'], m.voidboundHorror, 2);
  spawn(zhulBreachGrid['2,7'], m.zhulHerald, 2);
  spawn(zhulBreachGrid['6,7'], m.zhulHerald, 2);
  spawn(zhulBreachGrid['4,7'] /* The Devourer's Maw */, m.zhulDevourer, 1);

  // ---------------------------------------------------------------------
  // ITEM TEMPLATES
  // ---------------------------------------------------------------------
  const insertItem = db.prepare(`
    INSERT INTO item_templates (name, slot, required_level, bonus_atk, bonus_hp, price, source, is_quest_item, image)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET name=excluded.name RETURNING id
  `);
  const it = {};

  // Shop gear
  it.switchblade = insertItem.get('Rusty Switchblade', 'weapon', 1, 3, 0, 25, 'shop', 0, 'switchblade').id;
  it.bat = insertItem.get('Wooden Bat', 'weapon', 1, 4, 5, 40, 'shop', 0, 'bat').id;
  it.jacket = insertItem.get('Leather Jacket', 'chest', 1, 0, 18, 50, 'shop', 0, 'jacket').id;
  it.cap = insertItem.get('Street Cap', 'head', 1, 0, 10, 20, 'shop', 0, 'cap').id;
  it.knuckles = insertItem.get('Brass Knuckles', 'weapon', 3, 5, 0, 60, 'shop', 0, 'knuckles').id;
  it.pipe = insertItem.get('Steel Pipe', 'weapon', 5, 8, 0, 120, 'shop', 0, 'pipe').id;
  it.boots = insertItem.get('Combat Boots', 'boots', 5, 2, 12, 80, 'shop', 0, 'boots').id;
  it.kevlar = insertItem.get('Kevlar Vest', 'chest', 8, 0, 48, 200, 'shop', 0, 'kevlar').id;
  it.riotShield = insertItem.get('Riot Shield', 'shield', 10, 0, 38, 250, 'shop', 0, 'riotshield').id;
  it.bhNeck = insertItem.get('Bounty Hunter Neck', 'neck', 20, 21, 95, 500, 'shop', 0, 'bh_neck').id;

  // Shop gear, levels 10-30 (fills in the gap above Riot Shield, and adds the
  // hands/legs slots which previously had no shop items at all)
  it.steelChain = insertItem.get('Steel Chain', 'neck', 10, 8, 20, 180, 'shop', 0, 'gem_chain').id;
  it.reinforcedGloves = insertItem.get('Reinforced Gloves', 'hands', 10, 5, 15, 150, 'shop', 0, 'gloves').id;
  it.cargoPants = insertItem.get('Cargo Pants', 'legs', 12, 3, 30, 200, 'shop', 0, 'armored_pants').id;
  it.reinforcedHelmet = insertItem.get('Reinforced Helmet', 'head', 12, 2, 35, 220, 'shop', 0, 'full_motorcycle_helmet').id;
  it.machete = insertItem.get('Serrated Machete', 'weapon', 15, 14, 0, 320, 'shop', 0, 'machete').id;
  it.tacticalVest = insertItem.get('Tactical Vest', 'chest', 15, 5, 55, 340, 'shop', 0, 'chest_armor').id;
  it.steelToeBoots = insertItem.get('Steel-Toe Boots', 'boots', 18, 6, 30, 400, 'shop', 0, 'steeltoe_boots').id;
  it.spikedGauntlets = insertItem.get('Spiked Gauntlets', 'hands', 18, 10, 15, 420, 'shop', 0, 'gauntlet').id;
  it.nightVisionVisor = insertItem.get('Night Vision Visor', 'head', 20, 10, 25, 480, 'shop', 0, 'visored_helm').id;
  it.reinforcedCargoPants = insertItem.get('Reinforced Cargo Pants', 'legs', 22, 6, 60, 550, 'shop', 0, 'leg_armor').id;
  it.towerShield = insertItem.get('Tower Shield', 'shield', 22, 0, 100, 600, 'shop', 0, 'spiked_shield').id;
  it.warCleaver = insertItem.get('War Cleaver', 'weapon', 25, 26, 10, 750, 'shop', 0, 'war_axe').id;
  it.juggernautPlate = insertItem.get('Juggernaut Plate', 'chest', 28, 8, 90, 900, 'shop', 0, 'armor_vest').id;
  it.blastBoots = insertItem.get('Blast Boots', 'boots', 28, 12, 50, 800, 'shop', 0, 'boot_stomp').id;
  it.titanGripKnuckles = insertItem.get('Titan Grip Knuckles', 'hands', 30, 20, 25, 1100, 'shop', 0, 'mailed_fist').id;
  it.executionersAxe = insertItem.get("Executioner's Axe", 'weapon', 30, 32, 15, 1300, 'shop', 0, 'battle_axe').id;

  // Quest turn-in material (not equippable, not sellable)
  it.surgicalKit = insertItem.get('Surgical Kit', 'quest', 1, 0, 0, 0, 'quest', 1, 'surgical_kit').id;
  it.encryptedChip = insertItem.get('Encrypted Chip', 'quest', 1, 0, 0, 0, 'quest', 1, 'microchip').id;

  // Quest reward gear (better than comparable shop gear, only obtainable via quest)
  it.surgeonsTrophyBlade = insertItem.get("Surgeon's Trophy Blade", 'weapon', 16, 20, 25, 0, 'quest', 0, 'trophy_blade').id;
  it.runnersBracer = insertItem.get("Runner's Bracer", 'hands', 11, 7, 10, 0, 'quest', 0, 'gauntlet').id;

  // Dungeon-exclusive gear (only obtainable via the Underworks quest line)
  it.underworksPlate = insertItem.get('Underworks Plate', 'chest', 25, 12, 90, 0, 'dungeon', 0, 'underworks_plate').id;
  it.wardensCleaver = insertItem.get("Warden's Cleaver", 'weapon', 28, 40, 30, 0, 'dungeon', 0, 'wardens_cleaver').id;

  // Set-completing gear. Bounty Hunter Set is shop-purchasable (pairs with the existing
  // Bounty Hunter Neck); Warden's Grip is a rare bonus drop from The Warden himself,
  // giving a reason to keep fighting him after the main quest chain is done.
  it.bountyVest = insertItem.get('Bounty Hunter Vest', 'chest', 20, 15, 60, 550, 'shop', 0, 'bounty_vest').id;
  it.bountyBoots = insertItem.get('Bounty Hunter Boots', 'boots', 20, 8, 40, 400, 'shop', 0, 'bounty_boots').id;
  it.wardensGrip = insertItem.get("Warden's Grip", 'hands', 28, 18, 20, 0, 'dungeon', 0, 'wardens_grip').id;

  // The Docklands quest-line gear.
  it.smugglersVest = insertItem.get("Smuggler's Vest", 'chest', 27, 14, 80, 0, 'quest', 0, 'smugglers_vest').id;
  it.kanesGrappleHook = insertItem.get("Kane's Grapple Hook", 'weapon', 31, 35, 18, 0, 'dungeon', 0, 'kanes_grapple_hook').id;
  it.kanesGoldenAnchor = insertItem.get("Kane's Golden Anchor", 'neck', 31, 33, 105, 0, 'dungeon', 0, 'kanes_golden_anchor').id;

  // Zhul's Blessing set - the endgame quest chain's rewards, capped at Mythic (the tier
  // above Legendary). Zhul's Crown is a bonus drop from the final boss, same pattern as
  // Warden's Grip / Overseer's Core - keeps the finale worth revisiting after the quest is done.
  it.zhulsGrasp = insertItem.get("Zhul's Grasp", 'hands', 41, 30, 60, 0, 'dungeon', 0, 'zhuls_grasp').id;
  it.zhulsAegis = insertItem.get("Zhul's Aegis", 'chest', 44, 20, 160, 0, 'dungeon', 0, 'zhuls_aegis').id;
  it.zhulsAnnihilator = insertItem.get("Zhul's Annihilator", 'weapon', 47, 65, 50, 0, 'dungeon', 0, 'zhuls_annihilator').id;
  it.zhulsCrown = insertItem.get("Zhul's Crown", 'head', 47, 25, 90, 0, 'dungeon', 0, 'zhuls_crown').id;

  // Shop gear bridging levels 30-50, so the shop stays relevant alongside the new dungeon content.
  // Capped at Legendary - Mythic stays dungeon-exclusive, matching the existing "best gear is earned" pattern.
  it.riftForgedBlade = insertItem.get('Rift-Forged Blade', 'weapon', 32, 22, 10, 1800, 'shop', 0, 'rift_forged_blade').id;
  it.voidplateArmor = insertItem.get('Voidplate Armor', 'chest', 35, 14, 110, 2200, 'shop', 0, 'voidplate_armor').id;
  it.cultistsLeggings = insertItem.get("Cultist's Leggings", 'legs', 38, 10, 80, 1900, 'shop', 0, 'cultists_leggings').id;
  it.heraldsTreads = insertItem.get("Herald's Treads", 'boots', 42, 16, 65, 2600, 'shop', 0, 'heralds_treads').id;
  it.devourersCharm = insertItem.get("Devourer's Charm", 'neck', 46, 35, 110, 3200, 'shop', 0, 'devourers_charm').id;
  it.aegisOfBreach = insertItem.get('Aegis of the Breach', 'shield', 50, 0, 180, 3800, 'shop', 0, 'aegis_of_breach').id;

  // The Blacksite quest-line gear.
  it.blacksiteVisor = insertItem.get('Blacksite Visor', 'head', 20, 12, 40, 0, 'quest', 0, 'blacksite_visor').id;
  it.overseerRailgun = insertItem.get("Overseer's Railgun", 'weapon', 28, 38, 25, 0, 'dungeon', 0, 'overseer_railgun').id;
  it.overseerCore = insertItem.get("Overseer's Core", 'chest', 28, 15, 95, 0, 'dungeon', 0, 'overseer_core').id;

  // World boss reward - equippable by anyone who reaches level 25, droppable by anyone who helps
  // defeat the Kingpin regardless of their own level (see world_boss_drops below).
  it.kingpinsSignet = insertItem.get("Kingpin's Signet", 'neck', 25, 30, 100, 0, 'worldboss', 0, 'kingpins_signet').id;

  // ---------------------------------------------------------------------
  // MONSTER DROPS
  // ---------------------------------------------------------------------
  const insertDrop = db.prepare('INSERT OR IGNORE INTO monster_drops (monster_template_id, item_template_id, drop_chance) VALUES (?, ?, ?)');
  insertDrop.run(m.vileSurgeon, it.surgicalKit, 0.5);
  insertDrop.run(m.bladeRunner, it.encryptedChip, 0.4);
  insertDrop.run(m.theWarden, it.wardensGrip, 0.3);
  insertDrop.run(m.theOverseer, it.overseerCore, 0.3);
  insertDrop.run(m.dockmasterKane, it.kanesGoldenAnchor, 0.3);
  insertDrop.run(m.zhulDevourer, it.zhulsCrown, 0.3);

  // ---------------------------------------------------------------------
  // ITEM SETS - bonuses for equipping multiple pieces of a themed set at once.
  // ---------------------------------------------------------------------
  const insertSet = db.prepare('INSERT INTO item_sets (name, description) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET name=excluded.name RETURNING id');
  const insertSetBonus = db.prepare('INSERT OR IGNORE INTO set_bonuses (set_id, pieces_required, bonus_atk, bonus_hp) VALUES (?, ?, ?, ?)');
  const assignToSet = db.prepare('UPDATE item_templates SET set_id = ? WHERE id = ?');

  const bountyHunterSet = insertSet.get('Bounty Hunter Set', 'Neck, vest, and boots worn by the city\'s top bounty hunters.').id;
  [it.bhNeck, it.bountyVest, it.bountyBoots].forEach(itemId => assignToSet.run(bountyHunterSet, itemId));
  insertSetBonus.run(bountyHunterSet, 2, 8, 20);   // any 2 pieces
  insertSetBonus.run(bountyHunterSet, 3, 20, 50);  // full 3-piece set

  const smugglersLegacySet = insertSet.get("Smuggler's Legacy", "Vest, hook, and anchor pendant - everything left of Kane's operation.").id;
  [it.smugglersVest, it.kanesGrappleHook, it.kanesGoldenAnchor].forEach(itemId => assignToSet.run(smugglersLegacySet, itemId));
  insertSetBonus.run(smugglersLegacySet, 2, 16, 45);   // any 2 pieces
  insertSetBonus.run(smugglersLegacySet, 3, 38, 95);   // full 3-piece set

  const wardensRegaliaSet = insertSet.get("Warden's Regalia", "Weapon, plate, and grip stripped from the Underworks' ruler.").id;
  [it.wardensCleaver, it.underworksPlate, it.wardensGrip].forEach(itemId => assignToSet.run(wardensRegaliaSet, itemId));
  insertSetBonus.run(wardensRegaliaSet, 2, 15, 40);   // any 2 pieces
  insertSetBonus.run(wardensRegaliaSet, 3, 40, 100);  // full 3-piece set

  const zhulsBlessingSet = insertSet.get("Zhul's Blessing", "Grasp, aegis, blade, and crown - all that remains of what came through the Breach.").id;
  [it.zhulsGrasp, it.zhulsAegis, it.zhulsAnnihilator, it.zhulsCrown].forEach(itemId => assignToSet.run(zhulsBlessingSet, itemId));
  insertSetBonus.run(zhulsBlessingSet, 2, 20, 60);    // any 2 pieces
  insertSetBonus.run(zhulsBlessingSet, 3, 40, 120);   // any 3 pieces
  insertSetBonus.run(zhulsBlessingSet, 4, 70, 220);   // full 4-piece set

  // ---------------------------------------------------------------------
  // RARITY - drives the color-coded border/name in the UI. Assigned by level/source tier
  // rather than randomized, since gear here is template-based rather than procedurally rolled.
  // ---------------------------------------------------------------------
  const setRarity = db.prepare('UPDATE item_templates SET rarity = ? WHERE id = ?');
  const rarityGroups = {
    common: [it.switchblade, it.bat, it.jacket, it.cap],
    uncommon: [it.knuckles, it.pipe, it.boots, it.kevlar, it.riotShield, it.steelChain, it.reinforcedGloves],
    rare: [it.cargoPants, it.reinforcedHelmet, it.machete, it.tacticalVest, it.steelToeBoots, it.spikedGauntlets, it.surgeonsTrophyBlade, it.runnersBracer],
    epic: [it.bhNeck, it.nightVisionVisor, it.reinforcedCargoPants, it.towerShield, it.warCleaver, it.underworksPlate, it.bountyVest, it.bountyBoots, it.blacksiteVisor, it.riftForgedBlade, it.voidplateArmor, it.cultistsLeggings, it.smugglersVest],
    legendary: [it.juggernautPlate, it.blastBoots, it.titanGripKnuckles, it.executionersAxe, it.wardensCleaver, it.wardensGrip, it.overseerRailgun, it.overseerCore, it.kingpinsSignet, it.heraldsTreads, it.devourersCharm, it.aegisOfBreach, it.kanesGrappleHook, it.kanesGoldenAnchor],
    mythic: [it.zhulsGrasp, it.zhulsAegis, it.zhulsAnnihilator, it.zhulsCrown],
  };
  for (const [rarity, itemIds] of Object.entries(rarityGroups)) {
    itemIds.forEach(itemId => setRarity.run(rarity, itemId));
  }

  // ---------------------------------------------------------------------
  // QUESTS
  // ---------------------------------------------------------------------
  const insertQuest = db.prepare(`
    INSERT INTO quest_templates
      (name, description, type, target_monster_template_id, target_item_template_id, required_count,
       min_level, prerequisite_quest_id, reward_exp, reward_gold, reward_item_template_id, zone_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET name=excluded.name RETURNING id
  `);

  insertQuest.get(
    'Rat Extermination', 'The sewers under Main St. are overrun. Thin out the rat packs.',
    'kill', m.sewerRatPack, null, 15, 1, null, 450, 225, null, zoneMainSt
  );
  insertQuest.get(
    'Thief Patrol', 'Street thieves have been hitting shopkeepers all week. Deal with them.',
    'kill', m.streetThief, null, 10, 1, null, 360, 180, null, zoneMainSt
  );
  insertQuest.get(
    'Gang Turf War', 'The Back-Alley Thugs are pushing into new territory. Push back.',
    'kill', m.thug, null, 12, 3, null, 600, 300, null, zoneMainSt
  );
  insertQuest.get(
    'Scrapyard Cleanup', 'Scavengers have picked the scrapyard clean and turned violent over the scraps.',
    'kill', m.scavenger, null, 10, 5, null, 540, 270, null, zoneMainSt
  );
  insertQuest.get(
    'Night Watch', 'Something has been prowling the storm drains after dark. Put a stop to it.',
    'kill', m.nightProwler, null, 10, 7, null, 660, 330, null, zoneMainSt
  );
  insertQuest.get(
    'Rooftop Menace', 'A sniper has been taking potshots at pedestrians from the rooftops.',
    'kill', m.roofSniper, null, 8, 9, null, 780, 390, null, zoneMainSt
  );
  insertQuest.get(
    'New Blood', 'Corner dealers are flooding the streets with product. Shut them down.',
    'kill', m.cornerDealer, null, 12, 10, null, 900, 450, null, zoneAngelio
  );
  const bladeRunnerQuest = insertQuest.get(
    'Blade Runners', 'A crew of blade-wielding runners has been terrorizing the crossroads.',
    'kill', m.bladeRunner, null, 10, 11, null, 1020, 510, null, zoneAngelio
  ).id;
  insertQuest.get(
    'Silence Sid', 'Ganglord Sid controls this turf. Take him down and send a message.',
    'kill', m.ganglordSid, null, 1, 12, null, 1260, 660, null, zoneAngelio
  );
  insertQuest.get(
    'Lockdown', 'Safehouse guards are protecting something valuable. Break through.',
    'kill', m.safehouseGuard, null, 10, 13, null, 1140, 570, null, zoneAngelio
  );
  insertQuest.get(
    'Arms Deal Gone Wrong', 'Weapons smugglers are arming half the gangs in the city. Cut off the supply.',
    'kill', m.smuggler, null, 10, 14, null, 1260, 630, null, zoneAngelio
  );
  insertQuest.get(
    'Data Heist', 'Blade Runners carry encrypted chips with valuable data. Recover 5 of them.',
    'collect', null, it.encryptedChip, 5, 11, bladeRunnerQuest, 1050, 540, it.runnersBracer, zoneAngelio
  );

  insertQuest.get(
    "Surgeon's Missing Tools", 'The Vile Surgeon in the hospital basement drops surgical kits when defeated. Collect 5 of them.',
    'collect', null, it.surgicalKit, 5, 15, null, 1200, 450, it.surgeonsTrophyBlade, zoneHospital
  );

  // Dungeon quest line - a linear chain, each unlocked by completing the last.
  // The final reward is Warden's Cleaver, an exclusive weapon better than anything in the shop.
  const qd1 = insertQuest.get(
    'Into the Underworks I', 'Something has opened a path into the flooded sewers below the city. Clear out the grunts guarding the entrance.',
    'kill', m.underworksGrunt, null, 8, 20, null, 1500, 600, null, zoneUnderworks
  ).id;

  const qd2 = insertQuest.get(
    'Into the Underworks II', 'Deeper in, the Underworks Enforcers guard the passage to the Warden\'s domain.',
    'kill', m.underworksEnforcer, null, 6, 22, qd1, 2100, 900, it.underworksPlate, zoneUnderworks
  ).id;

  insertQuest.get(
    "The Warden's Fall", 'The Warden itself rules the deepest chamber of the Underworks. End its reign.',
    'kill', m.theWarden, null, 1, 25, qd2, 6000, 3000, it.wardensCleaver, zoneUnderworks
  );

  // The Blacksite quest line - same linear-chain pattern as the Underworks.
  const qb1 = insertQuest.get(
    'Breaching the Blacksite', 'A corporate research facility has gone dark. Its security drones are still active - shut them down.',
    'kill', m.securityDrone, null, 10, 18, null, 1800, 900, null, zoneBlacksite
  ).id;

  const qb2 = insertQuest.get(
    'Corporate Cleanup', 'Mercenaries hired to cover up the Blacksite are still on-site, eliminating loose ends. Eliminate them first.',
    'kill', m.mercenary, null, 8, 20, qb1, 2400, 1200, it.blacksiteVisor, zoneBlacksite
  ).id;

  insertQuest.get(
    'Silencing the Overseer', 'The Overseer coordinates everything left in the Blacksite. Bring it down and end the project for good.',
    'kill', m.theOverseer, null, 1, 24, qb2, 6500, 3200, it.overseerRailgun, zoneBlacksite
  );

  // Bridging quests - fill the gap between the existing dungeon caps (28-30) and
  // The Zhul Breach's minimum level (35), using the deepened dungeon content above.
  insertQuest.get(
    'Brood of the Deep', 'Something has been laying eggs in the flooded lower levels of the Underworks. Clear them out before they hatch.',
    'kill', m.broodmother, null, 8, 30, null, 2250, 1125, null, zoneUnderworks
  );
  insertQuest.get(
    'Prototype Purge', "Earlier, failed prototypes of the Overseer's design are still stumbling through the Blacksite's lower levels.",
    'kill', m.overseerPrototype, null, 8, 31, null, 2400, 1200, null, zoneBlacksite
  );

  // The Docklands - fills the level 24-31 gap between the older dungeons and The Zhul
  // Breach. Reward numbers are placeholders (0) - db.rebalanceQuestRewards() recalculates
  // every quest as 3x its target monster's (already-rebalanced) reward right after seeding.
  const qdock1 = insertQuest.get(
    'Cargo Bust', "Smugglers have taken over the pier. Clear them out before whatever they're moving hits the streets.",
    'kill', m.cargoSmuggler, null, 10, 24, null, 0, 0, null, zoneDocklands
  ).id;

  const qdock2 = insertQuest.get(
    'Breaking the Cartel', "The smugglers answer to someone. Take out their lieutenants and cut off the chain of command.",
    'kill', m.cartelLieutenant, null, 8, 27, qdock1, 0, 0, it.smugglersVest, zoneDocklands
  ).id;

  insertQuest.get(
    "The Dockmaster's Fall", "Dockmaster Kane runs this whole operation from his warehouse at the end of the pier. End it.",
    'kill', m.dockmasterKane, null, 1, 30, qdock2, 0, 0, it.kanesGrappleHook, zoneDocklands
  );

  // The Zhul Breach - the game's current endgame finale, a 5-quest chain culminating in
  // Zhul's Blessing, a Mythic 4-piece set (the tier above Legendary).
  const qz1 = insertQuest.get(
    'Cracks in Reality', 'A tear has opened in the fabric of the city itself. Rift Stalkers are pouring through - hold the line.',
    'kill', m.riftStalker, null, 12, 35, null, 2700, 1350, null, zoneZhulBreach
  ).id;

  const qz2 = insertQuest.get(
    'Cult of the Breach', 'A cult has formed around the rift, worshipping whatever is on the other side. Break their hold on this place.',
    'kill', m.zhulCultist, null, 10, 38, qz1, 3300, 1650, null, zoneZhulBreach
  ).id;

  const qz3 = insertQuest.get(
    'Echoes of the Warden', "Something wearing the shape of an old enemy shambles through the deeper rift - twisted, but not entirely unfamiliar.",
    'kill', m.corruptedHusk, null, 8, 41, qz2, 4050, 2025, it.zhulsGrasp, zoneZhulBreach
  ).id;

  const qz4 = insertQuest.get(
    'Into the Void', 'Beyond the husks, something with no shape at all waits in the dark between worlds.',
    'kill', m.voidboundHorror, null, 8, 44, qz3, 4650, 2325, it.zhulsAegis, zoneZhulBreach
  ).id;

  insertQuest.get(
    "The Devourer's End", 'At the heart of the Breach, Zhul the Devourer waits. End this, one way or another.',
    'kill', m.zhulDevourer, null, 1, 47, qz4, 15000, 7500, it.zhulsAnnihilator, zoneZhulBreach
  );

  // ---------------------------------------------------------------------
  // WORLD BOSS - shared server-wide fight, placed at the Main St. entrance (Town Square)
  // so every character passes through it naturally. Anyone can chip in regardless of level;
  // the Signet drop just requires level 25 to actually equip once you have it.
  // ---------------------------------------------------------------------
  const insertWorldBoss = db.prepare(`
    INSERT INTO world_bosses (name, room_id, level, max_hp, current_hp, attack, defense, respawn_seconds, total_exp_reward, total_gold_reward, image)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET name=excluded.name RETURNING id
  `);
  // Only touches `name` on conflict (a no-op) rather than every column - deliberately, so
  // restarting the server never resets an already-in-progress fight's current_hp/generation
  // back to full. This only needs to create the row the first time; after that its live
  // state is entirely managed by actual gameplay (see server/routes/worldboss.js).
  const kingpin = insertWorldBoss.get(
    'The Kingpin', mainStGrid['4,4'], 15, 50000, 50000, 30, 15, 10800, 6000, 4000, 'kingpin'
  ).id;

  const insertWorldBossDrop = db.prepare('INSERT OR IGNORE INTO world_boss_drops (world_boss_id, item_template_id, drop_chance) VALUES (?, ?, ?)');
  insertWorldBossDrop.run(kingpin, it.kingpinsSignet, 0.15);

  console.log(wasAlreadySeeded ? 'World content check complete.' : 'World seeded successfully.');
  console.log(`Zones: Main St. (Lv.1), Angelio St. (Lv.5), City Hospital (Lv.8), The Underworks (Lv.12, dungeon), The Blacksite (Lv.18, dungeon), The Docklands (Lv.24, dungeon), The Zhul Breach (Lv.35, dungeon)`);
  console.log(`Each zone is a ${GRID_SIZE}x${GRID_SIZE} grid (${GRID_SIZE * GRID_SIZE} rooms).`);

  db.rebalanceMonsterRewards();
  db.rebalanceQuestRewards();
}

seed();

module.exports = { seed };
