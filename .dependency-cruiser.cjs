// The layering rules. See docs/architecture.md.
module.exports = {
  forbidden: [
    {
      name: 'kernel-is-sovereign',
      comment: 'The kernel must not import from any layer above it.',
      severity: 'error',
      from: { path: '^src/kernel' },
      to: { path: '^src/(protocols|containers|stages)' },
    },
    {
      name: 'no-lateral-stage-imports',
      comment: 'Stages declare `requires`; they never import each other directly.',
      severity: 'error',
      from: { path: '^src/stages/([^/]+)/' },
      to: { path: '^src/stages/(?!$1)([^/]+)/' },
    },
    {
      name: 'protocols-emit-ir-only',
      comment: 'Protocol adapters must not know about feature stages.',
      severity: 'error',
      from: { path: '^src/protocols' },
      to: { path: '^src/stages' },
    },
    {
      name: 'no-lateral-protocol-imports',
      comment:
        'Adapters never reach across manifest families (hls never imports dash). ' +
        'Inside one family the docs-04 catalogue declares real requires ' +
        '(hls-live requires hls-cmaf), so same-family imports of pure parse ' +
        'code are the intended reuse.',
      severity: 'error',
      from: { path: '^src/protocols/(hls|dash)[^/]*/' },
      to: { path: '^src/protocols/(?!$1)(hls|dash)[^/]*/' },
    },
    {
      name: 'containers-are-leaf-ish',
      comment: 'Containers may use the kernel only.',
      severity: 'error',
      from: { path: '^src/containers' },
      to: { path: '^src/(protocols|stages)' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'zero-runtime-deps',
      comment: 'Mattebox has no runtime dependencies.',
      severity: 'error',
      from: { path: '^src' },
      to: { dependencyTypes: ['npm'] },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: { orphan: true, pathNot: '\\.d\\.ts$' },
      to: {},
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
    // Type-only imports count.
    tsPreCompilationDeps: true,
  },
};
