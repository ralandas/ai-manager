import postgres from 'postgres';
import dotenv from 'dotenv';
import { createPmsForOwner } from './src/pms/for-owner.js';

dotenv.config({ path: '/opt/ai-manager/.env' });
const sql = postgres(process.env.DATABASE_URL);

async function run() {
  const users = await sql`SELECT id, email, name, pms_provider, pms_credentials FROM users WHERE email = 'rauan.az.2006@gmail.com'`;
  console.log("USER:", JSON.stringify(users, null, 2));

  if (users.length) {
    const uid = users[0].id;
    try {
      console.log("Checking PMS for user", uid);
      const pms = await createPmsForOwner(uid);
      console.log("PMS Provider instance:", pms.constructor.name);
      const props = await pms.listProperties();
      console.log("Properties found in PMS:", props.length);
      console.log("Properties sample:", props.slice(0, 3));
    } catch (e) {
      console.error("PMS error:", e);
    }
  }

  const dbApartments = await sql`SELECT * FROM apartments WHERE owner_id = ${users[0]?.id}`;
  console.log("DB Apartments count:", dbApartments.length);

  await sql.end();
}

run();
