#!/usr/bin/env node
// scripts/apply-error-codes.mjs
//
// Bulk migration: replaces every `return json({ error: X.message }, N)`
// and `return err(X.message, N)` in data-gateway/actions with a call to
// `safeError(X)` from `_shared/errorMap.ts`, and ensures the import is
// present in each touched file.
//
// Idempotent: re-running on a migrated file is a no-op. Safe to commit the
// script so future contributors can re-apply the pattern after large edits.
//
// Run:  node scripts/apply-error-codes.mjs
// Or:   node scripts/apply-error-codes.mjs --dry   (just print what would change)

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DRY = process.argv.includes('--dry');
const ACTIONS_DIR = 'supabase/functions/data-gateway/actions';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

// Pattern A: `return json({ error: <var>.message }, <status>);`
// Allows optional inline space, trailing semicolon, status is any integer.
const RE_JSON = /return\s+json\s*\(\s*\{\s*error:\s*([a-zA-Z_$][\w$]*)\.message\s*\}\s*,\s*(\d+)\s*\)\s*;?/g;

// Pattern B: `return err(<var>.message, <status>);`
const RE_ERR = /return\s+err\s*\(\s*([a-zA-Z_$][\w$]*)\.message\s*,\s*(\d+)\s*\)\s*;?/g;

// Import detection: already present if any form of `safeError` is imported
// from the shared errorMap.ts relative path.
const RE_IMPORT_PRESENT = /from\s+['"](?:\.\.\/)+_shared\/errorMap\.ts['"]/;

const ADD_IMPORT = `import { safeError } from '../../_shared/errorMap.ts';`;

const summary = { files: 0, jsonReplaced: 0, errReplaced: 0, importsAdded: 0, skipped: [] };

for (const file of walk(ACTIONS_DIR)) {
  const original = readFileSync(file, 'utf8');
  let out = original;

  // Replace the JSON pattern
  out = out.replace(RE_JSON, (_m, varName, status) => {
    summary.jsonReplaced += 1;
    return `{ const _err = safeError(${varName}); return json(_err.body, _err.status); }`;
  });

  // Replace the err() pattern — uses the file's own `err` helper, so we
  // compute body+status via safeError and hand them back. Preserves the
  // existing wrapper chain (err() formats + sets CORS headers).
  out = out.replace(RE_ERR, (_m, varName, _status) => {
    summary.errReplaced += 1;
    return `{ const _err = safeError(${varName}); return err(_err.body.error, _err.status); }`;
  });

  if (out === original) continue;

  // Ensure import present
  if (!RE_IMPORT_PRESENT.test(out)) {
    // Place the import AFTER the last `} from '…';` line (so multi-line
    // imports aren't split) or AFTER the last single-line `import … from …;`,
    // whichever comes later. A naive "first non-import line" rule split
    // multi-line blocks and made the file a syntax error (v2.9.30 bugfix).
    const lines = out.split('\n');
    let lastImportEnd = -1;
    let inMultiLineImport = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (inMultiLineImport) {
        if (/^\s*}\s*from\s+['"][^'"]+['"]\s*;?\s*$/.test(line)) {
          inMultiLineImport = false;
          lastImportEnd = i;
        }
        continue;
      }
      if (/^\s*import\s+[^'"]*\{[^}]*$/.test(line)) {
        inMultiLineImport = true;
        continue;
      }
      if (/^\s*import\s+.*from\s+['"][^'"]+['"]\s*;?\s*$/.test(line)) {
        lastImportEnd = i;
      }
    }
    if (lastImportEnd === -1) {
      summary.skipped.push({ file, reason: 'no import block found' });
      continue;
    }
    lines.splice(lastImportEnd + 1, 0, ADD_IMPORT);
    out = lines.join('\n');
    summary.importsAdded += 1;
  }

  summary.files += 1;
  if (!DRY) writeFileSync(file, out);
}

console.log(JSON.stringify(summary, null, 2));
if (DRY) console.log('\n[dry run] no files written.');
