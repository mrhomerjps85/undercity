const express = require('express');
const session = require('express-session');
const path = require('path');
const http = require('http');

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
const socketLayer = require('./socket');

const app = express();
const PORT = process.env.PORT || 3000;

// Defined once so it can be shared between Express (HTTP requests) and Socket.IO
// (the socket layer authenticates using this same session, not anything the client claims).
const sessionMiddleware = session({
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

const httpServer = http.createServer(app);
socketLayer.init(httpServer, sessionMiddleware);

httpServer.listen(PORT, () => {
  console.log(`Outwar Clone server running at http://localhost:${PORT}`);
});
