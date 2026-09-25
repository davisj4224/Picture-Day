/* Run from the project folder when someone is locked out:
     npm run reset-password -- username newpassword          */

const bcrypt = require('bcryptjs');
const { db } = require('../lib/db');

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.log('Usage: npm run reset-password -- <username> <new password>');
  console.log('\nAccounts on this server:');
  db.prepare('SELECT username, role FROM users ORDER BY role').all().forEach((u) => console.log(`  ${u.username} (${u.role})`));
  process.exit(1);
}

if (password.length < 10) {
  console.error('Use a password of at least 10 characters.');
  process.exit(1);
}

const row = db.prepare('SELECT id FROM users WHERE username = ?').get(username.toLowerCase());
if (!row) {
  console.error(`No account named "${username}".`);
  process.exit(1);
}

db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(password, 12), row.id);
console.log(`Password for ${username} changed.`);
