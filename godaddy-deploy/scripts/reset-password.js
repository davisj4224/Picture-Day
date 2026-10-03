/* Run from the project folder:
     npm run reset-password -- username newpassword          */

const bcrypt = require('bcryptjs');
const { db, initialize } = require('../lib/db');

const [username, password] = process.argv.slice(2);

async function main() {
  await initialize();
  if (!username || !password) {
    console.log('Usage: npm run reset-password -- <username> <new password>');
    console.log('\nAccounts on this server:');
    const users = await db.prepare('SELECT username, role FROM users ORDER BY role').all();
    users.forEach((user) => console.log(`  ${user.username} (${user.role})`));
    process.exitCode = 1;
    return;
  }
  if (password.length < 10) throw new Error('Use a password of at least 10 characters.');
  const user = await db.prepare('SELECT id FROM users WHERE username = ?').get(username.toLowerCase());
  if (!user) throw new Error(`No account named "${username}".`);
  await db.prepare('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(password, 12), user.id);
  console.log(`Password for ${username} changed.`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
