// make-admin.js - One-time CLI script to grant admin panel access to an account.
// Usage: node server/scripts/make-admin.js your-username
//
// There's no UI for this deliberately - the very first admin has to be granted through
// a direct database command (there's no logged-in admin yet to click a button for you).
// Run this locally against your dev database, or on Render via the Shell tab against
// your production database.
const db = require('../db/db');

const username = process.argv[2];
if (!username) {
  console.error('Usage: node server/scripts/make-admin.js <username>');
  process.exit(1);
}

const user = db.prepare('SELECT id, username, is_admin FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`No account found with username "${username}".`);
  process.exit(1);
}

if (user.is_admin) {
  console.log(`${username} is already an admin.`);
  process.exit(0);
}

db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
console.log(`${username} is now an admin. Log out and back in to see the Admin tab.`);
