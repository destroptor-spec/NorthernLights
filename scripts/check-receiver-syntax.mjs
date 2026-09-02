#!/usr/bin/env node
/**
 * Parse the Cast receiver's inline scripts.
 *
 * public/receiver.html is covered by neither the type checker nor jest — it is
 * ES5 inline script in an HTML file. A syntax error there does not fail any
 * build; it fails at runtime on the Chromecast, where the symptom is "casting
 * is completely dead" and the only place to discover it is production.
 *
 * vm.Script compiles in script scope, matching how a browser parses it, and
 * never executes the code.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const FILE = 'public/receiver.html';
const html = readFileSync(FILE, 'utf8');

// Inline blocks only — skip <script src="…">.
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

if (blocks.length === 0) {
  console.error(`${FILE}: no inline script blocks found — has the file structure changed?`);
  process.exit(1);
}

let chars = 0;
blocks.forEach((source, index) => {
  chars += source.length;
  try {
    new vm.Script(source, { filename: `${FILE}#inline-${index + 1}` });
  } catch (error) {
    console.error(`${FILE}: inline script ${index + 1} of ${blocks.length} failed to parse`);
    console.error(`  ${error.message}`);
    process.exit(1);
  }
});

console.log(`${FILE}: ${blocks.length} inline script block(s), ${chars} chars — parsed OK`);
