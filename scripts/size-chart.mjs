#!/usr/bin/env node
// Renders docs/size-chart-{dark,light}.svg (the full preset against the other
// players) and docs/preset-chart-{dark,light}.svg (every preset). Mattebox rows
// are the built dist/cdn bundles; the other players are their latest npm
// tarballs, fetched at run time. Everything is min+gzip, compatibility builds.
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
  {
    bundle: 'mattebox.min.js',
    label: 'full',
    detail: '+ accessories',
    highlight: true,
  },
];

/** The other players: npm package and the browser bundle inside its tarball. */
const OTHERS = [
  {
    // VHS ships inside video.js and cannot run alone, so video.js is the bar.
    pkg: 'video.js',
    label: 'video.js + vhs',
    file: 'package/dist/video.min.js',
    detail: '',
  },
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

async function otherSizes() {
  const rows = [];
  for (const { pkg, label, file, detail } of OTHERS) {
    const meta = await (await fetch(`https://registry.npmjs.org/${pkg}/latest`)).json();
    const tgz = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
    const bytes = gzipSync(tarEntry(gunzipSync(tgz), file), { level: 9 }).length;
    rows.push({ label, version: `v${meta.version}`, detail, bytes, highlight: false });
  }
  return rows;
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

const others = (await otherSizes()).sort((a, b) => a.bytes - b.bytes);
const charts = [
  {
    file: 'size-chart',
    rows: [...matteboxRows(MATTEBOX, true), ...others],
    title: 'Adaptive streaming engine size',
    subtitle: "min+gzip · KB · each engine's compatibility build (lower is better)",
    ariaLabel: 'Bundle size of adaptive streaming players, min+gzip, lower is better',
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
