const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const http = require('http');
const fs = require('fs');

require('./db/seed'); // ensures world data exists on first run

const authRoutes = require('./routes/auth');
const { router: characterRoutes } = require('./routes/character');
const { router: worldRoutes } = require('./routes/world');
const combatRoutes = require('./routes/combat');
const inventoryRoutes = require('./routes/inventory');
const leaderboardRoutes = require('./routes/leaderboard');
const clanRoutes = require('./routes/clans');
const questRoutes = require('./routes/quests');
const worldBossRoutes = require('./routes/worldboss').router;
const adminRoutes = require('./routes/admin');
const newsRoutes = require('./routes/news');
const towerRoutes = require('./routes/tower');
const craftingRoutes = require('./routes/crafting');
const socketLayer = require('./socket');

const app = express();
const PORT = process.env.PORT || 3000;

// Sessions are stored as files instead of in memory, so a server restart or redeploy
// doesn't log everyone out. In production, set SESSIONS_PATH to a folder on your host's
// persistent disk (same disk as DB_PATH) so sessions survive redeploys too - otherwise
// this defaults to a local folder that's fine for dev but ephemeral on most hosts.
const sessionsDir = process.env.SESSIONS_PATH || path.join(__dirname, '..', '.sessions');
fs.mkdirSync(sessionsDir, { recursive: true });

// Defined once so it can be shared between Express (HTTP requests) and Socket.IO
// (the socket layer authenticates using this same session, not anything the client claims).
const sessionMiddleware = session({
  store: new FileStore({ path: sessionsDir, logFn: () => {} }),
  secret: process.env.SESSION_SECRET || 'outwar-clone-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 1 week
});

app.use(express.json());
app.use(sessionMiddleware);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/character', characterRoutes);
app.use('/api/world', worldRoutes);
app.use('/api/combat', combatRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/clans', clanRoutes);
app.use('/api/quests', questRoutes);
app.use('/api/worldboss', worldBossRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/tower', towerRoutes);
app.use('/api/crafting', craftingRoutes);

const httpServer = http.createServer(app);
socketLayer.init(httpServer, sessionMiddleware);

httpServer.listen(PORT, () => {
  console.log(`Outwar Clone server running at http://localhost:${PORT}`);
});
