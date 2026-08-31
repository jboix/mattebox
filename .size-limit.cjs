// One budget, enforced: the full stack as a page actually loads it, the
// script-tag bundle of the `full` preset plus the transmux Worker beside it,
// minified and gzipped, from the default ES2015 build. 60 kB is the line
// the pitch rests on: every stage, on the old-TV target, at a fraction of
// the other engines' compatibility builds. Per-preset figures are not
// budgets; the size chart (`pnpm run size-chart`) reports them.
//
// size-limit's kB is the SI kilobyte of 1000 bytes. Needs `pnpm build`.
module.exports = [
  {
    name: 'full',
    path: ['dist/cdn/mattebox.min.js', 'dist/cdn/transmux.worker.js'],
    gzip: true,
    limit: '60 kB',
  },
];
