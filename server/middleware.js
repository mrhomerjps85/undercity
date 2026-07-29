const db = require('./db/db');

// The real logged-in admin's session.userId never changes during impersonation - this
// resolves to the impersonated target's ID when one is active, otherwise the real user's
// own ID. Used for anything that should reflect "who am I playing as right now" (character
// lookups, gameplay actions); admin-permission checks deliberately keep using
// req.session.userId directly instead, since impersonating a regular player must never
// grant or affect the real admin's own admin privileges.
function getEffectiveUserId(req) {
  return req.session.impersonatingUserId || req.session.userId;
}

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

// Attaches req.character (the logged-in user's character, or the impersonated target's
// character while impersonating), 404s if none exists yet.
function requireCharacter(req, res, next) {
  const character = db.prepare('SELECT * FROM characters WHERE user_id = ?').get(getEffectiveUserId(req));
  if (!character) {
    return res.status(404).json({ error: 'No character found. Create one first.' });
  }
  req.character = character;
  next();
}

module.exports = { requireAuth, requireCharacter, getEffectiveUserId };
