/**
 * Import a database export: `npm run db:import -- <export.dump> [options]`.
 * Run on the target host with Aurora stopped. See docs/database_export_import.md.
 *
 *   --keep-secrets     keep the original's secrets (a migration: logins and apps keep working)
 *   --rotate-secrets   give the copy its own identity (a test copy)
 *   --target <db>      the database Aurora uses (default DB_NAME)
 *   --yes              switch without asking once the import is verified
 *   --no-switch        verify and leave the copy beside the current database
 */
import dotenv from 'dotenv';
dotenv.config();

import readline from 'readline';
import { connectDatabase, dbSettings } from '../server/services/databaseExport.service';
import { importDatabase, ImportRefusedError, type ClosableClient } from '../server/services/databaseImport.service';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dumpPath = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--target');

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase()); }));
}

async function connect(database: string): Promise<ClosableClient> {
  return connectDatabase(database);
}

async function main() {
  if (!dumpPath) {
    console.error('Usage: npm run db:import -- <export.dump> [--keep-secrets|--rotate-secrets] [--target <db>] [--yes|--no-switch]');
    process.exit(2);
  }
  if (flag('--keep-secrets') && flag('--rotate-secrets')) throw new ImportRefusedError('Choose either --keep-secrets or --rotate-secrets.');
  let rotate = flag('--rotate-secrets');
  if (!rotate && !flag('--keep-secrets')) {
    if (!process.stdin.isTTY) throw new ImportRefusedError('Pass --keep-secrets (a migration) or --rotate-secrets (a test copy).');
    const answer = await ask('Keep the original secrets (moving this server) or rotate them (a test copy)? [K/r] ');
    rotate = answer === 'r' || answer === 'rotate';
  }

  const admin = await connect('postgres');
  try {
    const result = await importDatabase({
      dumpPath,
      target: value('--target'),
      admin,
      connectTo: connect,
      rotate,
      log: line => console.log(line),
      confirmSwitch: async ({ target, imported, previous }) => {
        if (flag('--no-switch')) return false;
        if (flag('--yes')) return true;
        if (!process.stdin.isTTY) return false;
        const what = previous ? `rename "${target}" to "${previous}" and` : '';
        return (await ask(`Verified. Switch Aurora to it (${what} rename "${imported}" to "${target}")? [y/N] `)) === 'y';
      },
    });
    if (result.switched) {
      console.log('\nDone. Start Aurora again.');
      if (result.previous) {
        console.log(`To undo: stop Aurora, then in Postgres rename "${result.previous}" back to "${value('--target') || dbSettings().name}".`);
      }
    } else {
      console.log(`\nThe verified copy is "${result.imported}". Run again with --yes to switch, or drop it when done.`);
    }
  } finally {
    await admin.end();
  }
}

main().catch((error) => {
  const refused = error instanceof ImportRefusedError;
  console.error(`${refused ? 'Import refused' : 'Import failed'}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
