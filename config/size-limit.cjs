// Per-configuration budgets. Enforced numbers, not aspirations.
module.exports = [
  { name: 'kernel only', path: 'dist/presets/kernel.js', limit: '11 kB' },
  { name: 'hls-cmaf VOD + abr', path: 'dist/presets/hls-vod.js', limit: '17 kB' },
  { name: 'dual protocol + webvtt', path: 'dist/presets/dual.js', limit: '25 kB' },
  { name: 'dual + live + recovery', path: 'dist/presets/broadcast.js', limit: '32 kB' },
  { name: 'broadcast + audio + drm', path: 'dist/presets/premium.js', limit: '38 kB' },
  { name: 'full vhs parity', path: 'dist/presets/full.js', limit: '75 kB' },
];
