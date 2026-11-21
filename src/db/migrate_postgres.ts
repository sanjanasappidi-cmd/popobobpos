import { pgDatabase } from './pgDatabase.js';

async function runMigration() {
  console.log('[PostgreSQL] Running schema migration & seeding...');
  try {
    await pgDatabase.initSchema();
    console.log('✅ [PostgreSQL] Schema migration & seeding completed successfully!');
    process.exit(0);
  } catch (err: any) {
    console.error('❌ [PostgreSQL] Migration failed:', err.message);
    process.exit(1);
  }
}

runMigration();
