#!/usr/bin/env node
// Patches cli-spinners (a dep of node-llama-cpp's ora) to remove
// "import ... with { type: 'json' }" which Node 18 / Electron 28 cannot parse.
// Uses createRequire instead — valid ESM, no import attributes needed.

const fs   = require('fs')
const path = require('path')

const target = path.join(
  __dirname, '..', 'node_modules', 'node-llama-cpp',
  'node_modules', 'cli-spinners', 'index.js'
)

if (!fs.existsSync(target)) {
  console.log('[patch-node18] cli-spinners not found — skipping')
  process.exit(0)
}

const patched = `import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const spinners = require('./spinners.json');

export default spinners;

const spinnersList = Object.keys(spinners);

export function randomSpinner() {
  const randomIndex = Math.floor(Math.random() * spinnersList.length);
  const spinnerName = spinnersList[randomIndex];
  return spinners[spinnerName];
}
`

fs.writeFileSync(target, patched, 'utf8')
console.log('[patch-node18] Patched cli-spinners/index.js for Node 18 / Electron 28 compatibility')
