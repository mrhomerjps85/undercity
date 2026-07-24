const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.level, c.exp, c.gold, cl.name as clan_name
    FROM characters c
    LEFT JOIN clans cl ON cl.id = c.clan_id
    ORDER BY c.level DESC, c.exp DESC
    LIMIT 50
  `).all();
  res.json({ rankings: rows });
});

module.exports = router;
