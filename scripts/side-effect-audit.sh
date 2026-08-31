#!/usr/bin/env bash
# `sideEffects: false` is a promise. Import every built entry module in isolation
# and assert that doing so registers nothing — no registry global, no new globals at all.
set -euo pipefail

modules=$(find dist -name 'index.js' -not -path 'dist/legacy/*' -not -path 'dist/cdn/*' | sort)

if [ -z "${modules}" ]; then
  echo "ERROR: no built modules found — run pnpm build first"
  exit 1
fi

# shellcheck disable=SC2086
node --input-type=module -e "
import { pathToFileURL } from 'node:url';

const modules = process.argv.slice(1);
const before = new Set(Object.getOwnPropertyNames(globalThis));

for (const m of modules) {
  await import(pathToFileURL(m).href);
  if (globalThis.__mattebox_registry) {
    console.error('ERROR: ' + m + ' self-registered on import');
    process.exit(1);
  }
}

const leaked = Object.getOwnPropertyNames(globalThis).filter((k) => !before.has(k));
if (leaked.length > 0) {
  console.error('ERROR: importing modules created globals: ' + leaked.join(', '));
  process.exit(1);
}

console.log('side-effect audit passed (' + modules.length + ' module(s) imported cleanly)');
" ${modules}
