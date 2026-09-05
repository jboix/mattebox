// The one enforced budget: the full CDN bundle, min+gzip. The Worker is
// embedded, so this is the whole download. kB is 1000 bytes. Needs `pnpm build`.
module.exports = [
  {
    name: 'full',
    path: 'dist/cdn/mattebox.min.js',
    gzip: true,
    limit: '60 kB',
  },
];
