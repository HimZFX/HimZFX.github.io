// Entry point so that `node --test tests/admin/` (ADMIN_SPEC §3) works on Node 22:
// the runner passes the directory to `node`, which resolves it to this index.js.
// It loads every *.test.mjs file in this folder; e2e-*.mjs scripts are NOT run here.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.mjs')).sort();
  for (const f of files) await import(pathToFileURL(path.join(__dirname, f)).href);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
