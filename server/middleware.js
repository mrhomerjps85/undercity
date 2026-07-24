const db = require('./db/db');

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'You must be logged in.' });
  }
  // Re-checked on every request (not just at login) so a ban takes effect immediately
  // even for someone already mid-session, instead of waiting for their next login.
  const user = db.prepare('SELECT banned FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'You must be logged in.' });
  }
  if (user.banned) {
    req.session.destroy(() => {});
    return res.status(403).json({ error: 'This account has been banned.' });
  }
  next();
}

// Attaches req.character (the logged-in user's character), 404s if none exists yet.
function requireCharacter(req, res, next) {
  const character = db.prepare('SELECT * FROM characters WHERE user_id = ?').get(req.session.userId);
  if (!character) {
    return res.status(404).json({ error: 'No character found. Create one first.' });
  }
  req.character = character;
  next();
}

module.exports = { requireAuth, requireCharacter };
