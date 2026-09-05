// publint and attw on the packed tarball. attw cannot expand wildcard exports,
// so every entry point (a directory with an index.ts under a family) is passed
// by name, and its build output must exist.
import { spawnSync } from 'node:child_process';
import { existsSync, globSync } from 'node:fs';
import { fail } from './lib/fail.mjs';

const FAMILIES = ['stages', 'protocols', 'containers', 'presets'];

const entrypoints = FAMILIES.flatMap((family) =>
  globSync(`src/${family}/*/index.ts`)
    .sort()
    .map((file) => {
      const name = file.split(/[\\/]/).at(-2);
      for (const built of [
        `dist/${family}/${name}/index.js`,
        `dist/${family}/${name}/index.d.ts`,
      ]) {
        if (!existsSync(built)) fail(`${built} is missing; run pnpm build`);
      }
      return `${family}/${name}`;
    }),
);
console.log(`checking ${entrypoints.length} subpath entry points`);

/** Runs a command through the shell, so `pnpm` resolves on every platform, and stops on failure. */
function run(command) {
  const result = spawnSync(command, { stdio: 'inherit', shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('pnpm exec publint');
run(
  [
    'pnpm exec attw --pack . --format table-flipped --no-emoji',
    '--ignore-rules cjs-resolves-to-esm',
    `--include-entrypoints ${entrypoints.join(' ')}`,
  ].join(' '),
);
