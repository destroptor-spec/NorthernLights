/**
 * One-shot script: removes tracks whose file path no longer belongs to any
 * registered directory, then cleans up orphaned albums/artists/genres.
 *
 * Run with: npx tsx scripts/purge-orphans.ts
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const pool = new Pool({
  user: process.env.DB_USER || 'musicuser',
  password: process.env.DB_PASSWORD || 'musicpass',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'musicdb',
  connectionTimeoutMillis: 5000,
});

async function main() {
  const client = await pool.connect();
  try {
    // 1. Get all registered directories
    const dirsRes = await client.query('SELECT path FROM directories');
    const dirs: string[] = dirsRes.rows.map((r: any) => r.path);
    console.log(`Registered directories (${dirs.length}):`);
    dirs.forEach(d => console.log(`  ${d}`));

    // 2. Load all tracks
    const tracksRes = await client.query('SELECT id, path FROM tracks');
    console.log(`\nTotal tracks in DB: ${tracksRes.rows.length}`);

    // 3. Find tracks that don't belong to any registered directory
    const staleIds: string[] = [];
    for (const row of tracksRes.rows) {
      const fileBuf = Buffer.from(row.path as string, 'base64');
      const belongs = dirs.some(dir => {
        const dirBuf = Buffer.from(dir, 'utf8');
        const prefixMatches =
          fileBuf.length >= dirBuf.length &&
          fileBuf.slice(0, dirBuf.length).equals(dirBuf);
        const atBoundary =
          fileBuf.length === dirBuf.length ||
          fileBuf[dirBuf.length] === 0x2f; // '/'
        return prefixMatches && atBoundary;
      });
      if (!belongs) staleIds.push(row.id as string);
    }

    console.log(`Stale tracks (orphaned from removed directories): ${staleIds.length}`);
    if (staleIds.length > 0) {
      // Show a sample for confirmation
      const sample = staleIds.slice(0, 3).map(id => {
        const buf = Buffer.from(id, 'base64');
        return buf.toString('utf8');
      });
      console.log('Sample paths:');
      sample.forEach(p => console.log(`  ${p}`));
    }

    if (staleIds.length === 0) {
      console.log('\nNo stale tracks found. Nothing to do.');
    } else {
      // Delete stale tracks in chunks
      for (let i = 0; i < staleIds.length; i += 100) {
        const chunk = staleIds.slice(i, i + 100);
        const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(',');
        await client.query(`DELETE FROM tracks WHERE id IN (${placeholders})`, chunk);
      }
      console.log(`\n✓ Deleted ${staleIds.length} stale tracks`);

      // Clean up orphaned entity rows
      const albumRes = await client.query(`
        DELETE FROM albums
        WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)
        RETURNING id
      `);
      const artistRes = await client.query(`
        DELETE FROM artists
        WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks WHERE artist_id IS NOT NULL)
        RETURNING id
      `);
      const genreRes = await client.query(`
        DELETE FROM genres
        WHERE id NOT IN (SELECT DISTINCT genre_id FROM tracks WHERE genre_id IS NOT NULL)
        RETURNING id
      `);
      console.log(`✓ Purged ${albumRes.rowCount} orphaned albums`);
      console.log(`✓ Purged ${artistRes.rowCount} orphaned artists`);
      console.log(`✓ Purged ${genreRes.rowCount} orphaned genres`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
