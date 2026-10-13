/**
 * Export the database: `npm run db:export [-- --label <name>]`.
 * Writes backups/<name>.dump and its .json manifest (docs/database_export_import.md)
 * and exits non-zero on any failure, so a deploy can refuse to go ahead without one.
 */
import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase, runExport } from '../server/services/databaseExport.service';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  // A plain client with Aurora's settings; importing the server would run its schema statements.
  const client = await connectDatabase();
  try {
    const started = Date.now();
    const manifest = await runExport({ client, label: argValue('--label') });
    const mb = (manifest.dump.bytes / 1024 / 1024).toFixed(1);
    console.log(`Exported ${manifest.name} (${mb} MB, ${((Date.now() - started) / 1000).toFixed(1)} s, via ${manifest.dump.method})`);
    console.log(`  schema ${manifest.schemaFingerprint.slice(0, 12)}  commit ${manifest.app.commit}  sha256 ${manifest.dump.sha256.slice(0, 16)}…`);
    console.log(`  tracks ${manifest.rowCounts.tracks ?? 0}  track_features ${manifest.rowCounts.track_features ?? 0}  users ${manifest.rowCounts.users ?? 0}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Database export failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
