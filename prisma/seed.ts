import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL as string });
const db = new PrismaClient({ adapter });

async function main() {
  const existing = await db.user.findFirst({
    where: { role: 'SUPER_ADMIN' },
  });

  if (existing) {
    console.log('⚠️  A SUPER_ADMIN already exists:', existing.username);
    return;
  }

  const hashedPassword = await bcrypt.hash('SuperAdmin@123', 10);

  const superAdmin = await db.user.create({
    data: {
      username: 'superadmin',
      email: 'superadmin@safi-pos.com',
      password: hashedPassword,
      role: 'SUPER_ADMIN',
    },
  });

  console.log('✅ SUPER_ADMIN created successfully!');
  console.log('─────────────────────────────────');
  console.log('  Username :', superAdmin.username);
  console.log('  Email    :', superAdmin.email);
  console.log('  Password : SuperAdmin@123');
  console.log('─────────────────────────────────');
  console.log('⚠️  Change the password after first login!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
