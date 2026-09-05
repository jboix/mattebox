// Importing every built entry module must register nothing. Needs `pnpm build`.
import { globSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fail } from './lib/fail.mjs';

const modules = globSync('dist/**/index.js', { exclude: ['dist/es2015/**', 'dist/cdn/**'] }).sort();
if (modules.length === 0) fail('no built modules found; run pnpm build first');

const before = new Set(Object.getOwnPropertyNames(globalThis));
for (const module of modules) {
  await import(pathToFileURL(module).href);
  if ('__mattebox_registry' in globalThis) fail(`${module} self-registered on import`);
}

const leaked = Object.getOwnPropertyNames(globalThis).filter((key) => !before.has(key));
if (leaked.length > 0) fail(`importing modules created globals: ${leaked.join(', ')}`);

console.log(`side-effect audit passed (${modules.length} module(s) imported cleanly)`);
