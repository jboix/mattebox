// Fails the build on any banned TypeScript construct's footprint in the
// modern output. Checks emitted output rather than an AST rule per feature,
// so it catches the actual harm. Run after `pnpm build`.
import { globSync, readFileSync } from 'node:fs';
import { fail } from './lib/fail.mjs';

const BANNED = /__publicField|tslib|regenerator|__decorate|__createBinding|__spreadArray/;
// The modern build must have no runtime imports outside itself.
const BARE_IMPORT = /from ['"][^./]/;

const files = globSync('dist/**/*.js', { exclude: ['dist/es2015/**'] }).sort();
if (files.length === 0) fail('no built modules found; run pnpm build first');

const banned = files.filter((file) => BANNED.test(readFileSync(file, 'utf8')));
if (banned.length > 0) fail('banned TypeScript construct found in modern output', banned);

const bare = files.filter((file) => BARE_IMPORT.test(readFileSync(file, 'utf8')));
if (bare.length > 0) fail('bare import specifier in output; a runtime dependency leaked in', bare);

console.log(`emit check passed (${files.length} files)`);
