import { database, transaction } from '../lib/db';
const email = process.argv[2]?.trim().toLowerCase();
if (!email) throw new Error('Usage: npm run admin -- existing-account@example.com');
try {
  await transaction(async db => {
    const { rows } = await db.query("UPDATE users SET role='admin',access_approved=true WHERE email=$1 AND NOT disabled RETURNING id",[email]);
    if (!rows.length) throw new Error('Register the account first.');
    await db.query("INSERT INTO audit_logs(user_id,action,target) VALUES($1,'admin.promoted',$2)",[rows[0].id,rows[0].id]);
  });
  console.log('Admin role assigned.');
} finally { await database().end(); }
