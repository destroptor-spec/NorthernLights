const { PGlite } = require('@electric-sql/pglite');
const { vector } = require('@electric-sql/pglite/vector');
const path = require('path');

const dbPath = path.resolve(__dirname, 'server/library-pg');

async function test() {
  console.log('Testing PGlite instantiation on:', dbPath);
  try {
    const db = new PGlite(dbPath, {
      extensions: { vector }
    });
    console.log('Waiting for ready...');
    await db.waitReady;
    console.log('PGlite is ready!');
    
    const res = await db.query('SELECT 1 as val');
    console.log('Query success:', res.rows);
    process.exit(0);
  } catch (e) {
    console.error('PGlite failed to boot:', e);
    process.exit(1);
  }
}

test();
