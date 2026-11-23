#!/usr/bin/env node
// Renders docs/size-chart-{dark,light}.svg (the full preset against the other
// players), docs/hls-chart-{dark,light}.svg (HLS alone against the other
// players' HLS builds) and docs/preset-chart-{dark,light}.svg (every preset).
// Mattebox rows are the built dist/cdn bundles, ES2015; the other players are
// pinned npm versions, fetched at run time. Bump a version here to move its
// bar. Everything is min+gzip. The size chart takes each engine's
// compatibility build. The HLS chart takes the smallest build each project
// publishes that plays HLS with fMP4 and MPEG-TS segments and DRM.
//
//   pnpm run build && pnpm run size-chart
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs');

/** The Mattebox rows: the cdn bundle and the label the chart shows. */
const MATTEBOX = [{ bundle: 'mattebox.min.js', label: 'mattebox', detail: '' }];

/** The preset chart rows: cdn bundle, the preset's name, and what the row adds. */
const PRESETS = [
  { bundle: 'mattebox.kernel.min.js', label: 'kernel', detail: 'the engine alone' },
  { bundle: 'mattebox.hls.min.js', label: 'hls', detail: 'HLS line + base' },
  { bundle: 'mattebox.hls-drm.min.js', label: 'hls-drm', detail: '+ EME' },
  { bundle: 'mattebox.hls-ts.min.js', label: 'hls-ts', detail: '+ MPEG-TS' },
  {
    bundle: 'mattebox.hls-ts-drm.min.js',
    label: 'hls-ts-drm',
    detail: '+ MPEG-TS + EME',
  },
  { bundle: 'mattebox.dash.min.js', label: 'dash', detail: 'DASH line + base' },
  { bundle: 'mattebox.dash-drm.min.js', label: 'dash-drm', detail: '+ EME' },
  { bundle: 'mattebox.dual.min.js', label: 'dual', detail: 'both lines + base' },
  { bundle: 'mattebox.dual-drm.min.js', label: 'dual-drm', detail: '+ EME' },
  { bundle: 'mattebox.dual-ts.min.js', label: 'dual-ts', detail: '+ MPEG-TS' },
  {
    bundle: 'mattebox.dual-ts-drm.min.js',
    label: 'dual-ts-drm',
    detail: '+ MPEG-TS + EME',
  },
  { bundle: 'mattebox.hls-ll.min.js', label: 'hls-ll', detail: 'low-latency HLS + base' },
  { bundle: 'mattebox.dash-ll.min.js', label: 'dash-ll', detail: 'low-latency DASH + base' },
  { bundle: 'mattebox.dual-ll.min.js', label: 'dual-ll', detail: 'both low-latency lines + base' },
  {
    bundle: 'mattebox.min.js',
    label: 'full',
    detail: '+ accessories',
    highlight: true,
  },
];

/** The Mattebox row of the HLS chart: the preset with HLS, MPEG-TS and DRM. */
const MATTEBOX_HLS = [
  { bundle: 'mattebox.hls-ts-drm.min.js', label: 'mattebox', detail: 'hls-ts-drm preset' },
];

/** The pinned version of each other player, one for every chart. */
const VERSIONS = {
  'hls.js': '1.7.2',
  'shaka-player': '5.2.9',
  dashjs: '5.2.1',
  'bitmovin-player': '8.279.0',
};

/**
 * The other players: npm package, label, and the browser bundle inside its
 * tarball. `files` instead of `file` lists several, which a page loads together.
 */
const OTHERS = [
  { pkg: 'hls.js', label: 'hls.js', file: 'package/dist/hls.min.js', detail: '' },
  {
    pkg: 'shaka-player',
    label: 'shaka player',
    // Shaka's default and most compatible build, ES5; the es2021 file is the opt-in.
    file: 'package/dist/shaka-player.compiled.js',
    detail: '',
  },
  {
    pkg: 'dashjs',
    label: 'dash.js',
    // dash.js's compatibility build; its default export is the modern one.
    file: 'package/dist/legacy/umd/dash.all.min.js',
    detail: '',
  },
];

/**
 * The Bitmovin modules that play HLS with fMP4 and MPEG-TS segments and DRM,
 * without an interface: the player, the engine under HLS, its Media Source
 * renderer, bitrate adaptation, HLS, both containers and DRM. The dependencies
 * are the ones `ModuleName` documents in the package's own types.
 */
const BITMOVIN_HLS = [
  'core',
  'engine-bitmovin',
  'mserenderer',
  'abr',
  'hls',
  'container-mp4',
  'container-ts',
  'drm',
];

/**
 * The HLS chart's other players: the smallest build each one publishes that
 * plays HLS with fMP4 and MPEG-TS segments and DRM, without an interface.
 */
const OTHERS_HLS = [
  // The full build as an ES module, smaller than `hls.min.js`. The light
  // build is smaller still and has no EME.
  { pkg: 'hls.js', label: 'hls.js', file: 'package/dist/hls.min.mjs', detail: 'esm build' },
  {
    pkg: 'shaka-player',
    label: 'shaka player',
    // The HLS build has no DASH, interface, Cast or offline storage. The
    // package ships it for ES5 and for ES2021; this is the smaller one.
    file: 'package/dist/shaka-player.hls-es2021.js',
    detail: 'hls build, es2021',
  },
  {
    pkg: 'bitmovin-player',
    label: 'bitmovin player',
    // A commercial player. Its package holds each module as a file, and
    // `.prod.js` is the one without the debug log messages.
    files: BITMOVIN_HLS.map((name) => `package/modules/bitmovinplayer-${name}.prod.js`),
    detail: 'hls modules',
  },
];

const CDN = join(ROOT, 'dist', 'cdn');

/** min+gzip bytes of one built bundle. */
function bundleBytes(bundle) {
  let bytes;
  try {
    bytes = readFileSync(join(CDN, bundle));
  } catch {
    throw new Error(`${bundle} is not built; run \`pnpm build\` first`);
  }
  return gzipSync(bytes, { level: 9 }).length;
}

function matteboxRows(specs, highlightAll) {
  return specs.map(({ bundle, label, detail, highlight }) => ({
    label,
    version: 'main',
    detail,
    bytes: bundleBytes(bundle),
    highlight: highlightAll || highlight === true,
  }));
}

/** Reads one file out of an uncompressed tar archive. */
function tarEntry(tar, wanted) {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const name = tar
      .subarray(offset, offset + 100)
      .toString('utf8')
      .replace(/\0.*$/s, '');
    if (name === '') break;
    const size = Number.parseInt(
      tar
        .subarray(offset + 124, offset + 136)
        .toString('utf8')
        .trim(),
      8,
    );
    const prefix = tar
      .subarray(offset + 345, offset + 500)
      .toString('utf8')
      .replace(/\0.*$/s, '');
    const full = prefix === '' ? name : `${prefix}/${name}`;
    if (full === wanted) return tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`'${wanted}' is not in the tarball`);
}

/** The unpacked tarball of each package fetched so far, by name and version. */
const tarballs = new Map();

/** Fetches a package's tarball at its pinned version, once per run. */
async function tarballOf(pkg) {
  const key = `${pkg}@${VERSIONS[pkg]}`;
  if (!tarballs.has(key)) {
    const meta = await (await fetch(`https://registry.npmjs.org/${pkg}/${VERSIONS[pkg]}`)).json();
    const tgz = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
    tarballs.set(key, { version: meta.version, tar: gunzipSync(tgz) });
  }
  return tarballs.get(key);
}

/** min+gzip bytes of each other player's bundle. Several files are joined, then compressed. */
async function otherSizes(specs) {
  const rows = [];
  for (const { pkg, label, file, files = [file], detail } of specs) {
    const { version, tar } = await tarballOf(pkg);
    const bundle = Buffer.concat(files.map((each) => tarEntry(tar, each)));
    const bytes = gzipSync(bundle, { level: 9 }).length;
    rows.push({ label, version: `v${version}`, detail, bytes, highlight: false });
  }
  return rows.sort((a, b) => a.bytes - b.bytes);
}

const THEMES = {
  dark: {
    bg: '#0b0b0d',
    text: '#f4f4f5',
    muted: '#8a8a93',
    track: '#18181c',
    bar: '#9a9aa2',
    accent: '#f5a524',
    axis: '#3a3a42',
  },
  light: {
    bg: '#ffffff',
    text: '#111114',
    muted: '#6b6b74',
    track: '#f0f0f3',
    bar: '#a1a1aa',
    accent: '#e8930c',
    axis: '#d4d4d9',
  },
};

const kb = (bytes) => bytes / 1024;
const fmt = (bytes) => `${kb(bytes).toFixed(1)} KB`;

function render(rows, theme, { title, subtitle, ariaLabel, tick }) {
  const t = THEMES[theme];
  const width = 1100;
  const left = 290;
  const right = 900;
  const rowH = 84;
  const barH = 54;
  const top = 150;
  const maxKb = Math.ceil(Math.max(...rows.map((r) => kb(r.bytes))) / tick) * tick;
  const scale = (right - left) / maxKb;
  const height = top + rows.length * rowH + 80;
  const font = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  const mono = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

  const bars = rows
    .map((row, i) => {
      const y = top + i * rowH;
      const w = Math.max(3, kb(row.bytes) * scale);
      const fill = row.highlight ? t.accent : t.bar;
      const nameWeight = row.highlight ? 700 : 400;
      const valueWeight = row.highlight ? 700 : 400;
      const valueSize = row.highlight ? 30 : 26;
      return `
  <text x="44" y="${y + 26}" font-family="${font}" font-size="26" font-weight="${nameWeight}" fill="${t.text}">${row.label}</text>
  <text x="44" y="${y + 50}" font-family="${mono}" font-size="15" fill="${t.muted}">${row.version}${row.detail === '' ? '' : ` · ${row.detail}`}</text>
  <rect x="${left}" y="${y}" width="${right - left}" height="${barH}" fill="${t.track}"/>
  <rect x="${left}" y="${y}" width="${w.toFixed(1)}" height="${barH}" fill="${fill}"/>
  <text x="${width - 44}" y="${y + 36}" text-anchor="end" font-family="${mono}" font-size="${valueSize}" font-weight="${valueWeight}" fill="${row.highlight ? t.text : t.muted}">${fmt(row.bytes)}</text>`;
    })
    .join('');

  const ticks = [];
  for (let v = 0; v <= maxKb; v += tick) {
    const x = left + v * scale;
    ticks.push(
      `<line x1="${x.toFixed(1)}" y1="${height - 62}" x2="${x.toFixed(1)}" y2="${height - 54}" stroke="${t.axis}" stroke-width="2"/>`,
      `<text x="${x.toFixed(1)}" y="${height - 30}" text-anchor="middle" font-family="${mono}" font-size="15" fill="${t.muted}">${v}</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${ariaLabel}">
  <rect width="${width}" height="${height}" rx="18" fill="${t.bg}"/>
  <text x="44" y="60" font-family="${font}" font-size="34" font-weight="700" fill="${t.text}">${title}</text>
  <text x="44" y="98" font-family="${font}" font-size="22" fill="${t.muted}">${subtitle}</text>${bars}
  <line x1="${left}" y1="${height - 62}" x2="${right}" y2="${height - 62}" stroke="${t.axis}" stroke-width="2"/>
  ${ticks.join('\n  ')}
</svg>
`;
}

const charts = [
  {
    file: 'size-chart',
    rows: [...matteboxRows(MATTEBOX, true), ...(await otherSizes(OTHERS))],
    title: 'Adaptive streaming engine size',
    subtitle: "min+gzip · KB · each engine's compatibility build (lower is better)",
    ariaLabel: 'Bundle size of adaptive streaming players, min+gzip, lower is better',
    tick: 50,
  },
  {
    file: 'hls-chart',
    rows: [...matteboxRows(MATTEBOX_HLS, true), ...(await otherSizes(OTHERS_HLS))],
    title: 'HLS engine size',
    subtitle:
      'min+gzip · KB · the smallest build of each with HLS, MPEG-TS and DRM (lower is better)',
    ariaLabel:
      'Bundle size of engines that play HLS with fMP4 and MPEG-TS segments and DRM, min+gzip, lower is better',
    tick: 50,
  },
  {
    file: 'preset-chart',
    rows: matteboxRows(PRESETS, false),
    title: 'Mattebox presets',
    subtitle: 'min+gzip · KB · a protocol line, the MPEG-TS tier (worker inside), the DRM tier',
    ariaLabel: 'Bundle size of every Mattebox preset, min+gzip',
    tick: 10,
  },
];
mkdirSync(OUT, { recursive: true });
for (const chart of charts) {
  for (const theme of Object.keys(THEMES)) {
    const path = join(OUT, `${chart.file}-${theme}.svg`);
    writeFileSync(path, render(chart.rows, theme, chart));
    console.log(`wrote ${path}`);
  }
  for (const row of chart.rows) {
    console.log(
      `${row.label.padEnd(14)} ${row.version.padEnd(9)} ${fmt(row.bytes).padStart(10)}  (${row.detail})`,
    );
  }
}
