#!/usr/bin/env node
/**
 * Parse the Cast receiver's scripts.
 *
 * public/receiver.html and public/receiver-follow.js are covered by neither
 * the type checker nor the build. A syntax error there does not fail any
 * build; it fails at runtime on the Chromecast, where the symptom is "casting
 * is completely dead" and the only place to discover it is production.
 *
 * The oldest receiver in use runs Chrome 62 (Beoplay A9, probe 2026-10-16),
 * so both are parsed as ES2017: anything newer (optional chaining, `??`,
 * object spread) fails here instead of on that device. Two runtime APIs it
 * lacks are refused by name: Promise.prototype.finally and AbortController.
 *
 * vm.Script compiles in script scope, matching how a browser parses it, and
 * never executes the code. acorn (a dependency of the build tools) supplies
 * the ES2017 check; without it only vm.Script runs.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const RECEIVER = 'public/receiver.html';
const FOLLOW = 'public/receiver-follow.js';
const ECMA_VERSION = 2017;
const UNSUPPORTED_APIS = [/\.finally\s*\(/, /\bAbortController\b/];

let acorn = null;
try {
  acorn = await import('acorn');
} catch {
  console.warn('acorn not available: checking syntax with vm.Script only (no ES2017 limit)');
}

function check(label, source, { apis }) {
  try {
    new vm.Script(source, { filename: label });
    if (acorn) acorn.parse(source, { ecmaVersion: ECMA_VERSION, sourceType: 'script' });
  } catch (error) {
    console.error(`${label} failed to parse${acorn ? ` as ES${ECMA_VERSION}` : ''}`);
    console.error(`  ${error.message}`);
    process.exit(1);
  }
  if (!apis) return;
  // Comments mention the APIs on purpose; only code counts.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const pattern of UNSUPPORTED_APIS) {
    if (pattern.test(code)) {
      console.error(`${label} uses ${pattern.source.replace(/\\b|\\s\*\\\(|\\/g, '')}, which Chrome 62 receivers lack`);
      process.exit(1);
    }
  }
}

const html = readFileSync(RECEIVER, 'utf8');
// Inline blocks only — skip <script src="…">.
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (blocks.length === 0) {
  console.error(`${RECEIVER}: no inline script blocks found — has the file structure changed?`);
  process.exit(1);
}
if (!html.includes('<script src="receiver-follow.js"></script>')) {
  console.error(`${RECEIVER}: does not load receiver-follow.js — has the file structure changed?`);
  process.exit(1);
}

let chars = 0;
blocks.forEach((source, index) => {
  chars += source.length;
  // The inline script predates the limit on APIs; its syntax is held to ES2017.
  check(`${RECEIVER}#inline-${index + 1}`, source, { apis: false });
});
const follow = readFileSync(FOLLOW, 'utf8');
check(FOLLOW, follow, { apis: true });

console.log(`${RECEIVER}: ${blocks.length} inline script block(s), ${chars} chars — parsed OK; ${FOLLOW}: ${follow.length} chars — parsed OK`);
