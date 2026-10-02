// The one enforced budget: the full CDN bundle, min+gzip, measured as the
// file is served. The Worker is embedded, so this is the whole download.
// kB is 1000 bytes. Needs `pnpm build`.
module.exports = [
  {
    name: 'full',
    path: 'dist/cdn/mattebox.min.js',
    gzip: true,
    // The file as served: size-limit would otherwise bundle it again with
    // esbuild, which adds about 4 kB of wrapper that nobody downloads.
    disablePlugins: ['@size-limit/esbuild'],
    limit: '100 kB',
  },
];
