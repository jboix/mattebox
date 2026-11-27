import { dirname, resolve } from 'node:path';
import { defineConfig, rolldown } from 'rolldown';

// CDN bundles: one minified IIFE per preset behind the `mattebox` global.
// The transmux is compiled first into one self-contained function, which the
// main thread calls and the Worker starts from, so a page loads one file
// holding one copy.
const PRESETS = [
  'kernel',
  'hls',
  'hls-drm',
  'hls-ts',
  'hls-ts-drm',
  'dash',
  'dash-drm',
  'dual',
  'dual-drm',
  'dual-ts',
  'dual-ts-drm',
  'hls-ll',
  'dash-ll',
  'dual-ll',
];

/** The presets whose bundle carries the transmux, beside the full one. */
const WITH_TRANSMUX = new Set(['hls-ts', 'hls-ts-drm', 'dual-ts', 'dual-ts-drm']);

// The package's default target, the same as dist/es2015.
const TARGET = 'es2015';

const TRANSMUX_MODULE = 'virtual:transmux-module';
const TRANSMUX_INPUT = resolve('src/containers/ts-transmux/module.ts');
const SHARED_PREFIX = '\0from-transmux:';
const NPM_SOURCE = resolve('src/containers/ts-transmux/source.ts');
const CDN_SOURCE = resolve('cdn/transmux-source.ts');
const CDN_INSTANCE = resolve('cdn/transmux-instance.ts');

/**
 * What the main thread takes from the compiled transmux, by module. The
 * transmux holds this code for the Worker already, so a bundle with the
 * transmux in it would otherwise carry it twice. A name the main thread
 * imports and this list lacks fails the build, as a missing export.
 */
const SHARED = new Map(
  Object.entries({
    'src/containers/fmp4/writer.ts': [
      'concat',
      'sequenceNumberFor',
      'writeInitSegment',
      'writeMediaSegment',
    ],
    'src/containers/adts.ts': ['adtsFragment', 'parseAdts'],
    'src/containers/sei.ts': ['ccTriplesFromSei'],
    'src/containers/ts-transmux/sniff.ts': ['looksLikeTransportStream'],
    'src/containers/ts-transmux/demux.ts': ['looksLikeTransportStream', 'programTables'],
  }).map(([file, names]) => [resolve(file), names]),
);

/**
 * Adds to the transmux module the names the main thread takes from it, so
 * the compiled function exports them beside the transmux and its Worker side.
 */
const exportShared = {
  name: 'export-shared',
  transform(code, id) {
    if (id !== TRANSMUX_INPUT) return null;
    const lines = [code];
    const exported = new Set();
    for (const [file, names] of SHARED) {
      const fresh = names.filter((name) => !exported.has(name));
      for (const name of fresh) exported.add(name);
      if (fresh.length > 0) lines.push(`export { ${fresh.join(', ')} } from '${file}';`);
    }
    return { code: lines.join('\n'), map: null };
  },
};

let transmuxCode;
/** The transmux and its Worker side, compiled once to a minified IIFE assigning `__transmux`. */
function compiledTransmux() {
  transmuxCode ??= (async () => {
    const build = await rolldown({
      input: 'src/containers/ts-transmux/module.ts',
      plugins: [exportShared],
      transform: { target: TARGET },
    });
    const { output } = await build.generate({ format: 'iife', name: '__transmux', minify: true });
    await build.close();
    return output[0].code;
  })();
  return transmuxCode;
}

/**
 * The transmux ships once. `virtual:transmux-module` is a function holding
 * the compiled transmux and returning it: the main thread calls it, and the
 * Worker starts from its source text, so it must reference nothing outside
 * itself, which the separate compile guarantees. The stage's `./source.js`
 * resolves to cdn/transmux-source.ts, so the npm source, whose dynamic import
 * an IIFE would inline as a second copy, never enters the bundle.
 *
 * In a bundle that carries the transmux, a main-thread import of a module in
 * SHARED resolves to the names of the one instance, so the code the Worker
 * and the main thread both run is in the file once. A bundle without the
 * transmux keeps the modules as they are: taking them from the transmux
 * would bring the whole of it in.
 *
 * @param {boolean} share - Whether the bundle carries the transmux.
 */
function shipTransmuxOnce(share) {
  return {
    name: 'ship-transmux-once',
    async resolveId(id, importer) {
      if (id === TRANSMUX_MODULE) return `\0${TRANSMUX_MODULE}`;
      if (importer === undefined || !id.startsWith('.') || importer.startsWith('\0')) return null;
      const target = resolve(dirname(importer), id.replace(/\.js$/, '.ts'));
      if (target === NPM_SOURCE) return CDN_SOURCE;
      return share && SHARED.has(target) ? `${SHARED_PREFIX}${target}` : null;
    },
    async load(id) {
      if (id.startsWith(SHARED_PREFIX)) {
        const names = SHARED.get(id.slice(SHARED_PREFIX.length));
        return [
          `import { instance } from '${CDN_INSTANCE}';`,
          ...names.map((name) => `export const ${name} = instance.${name};`),
        ].join('\n');
      }
      if (id !== `\0${TRANSMUX_MODULE}`) return null;
      const code = await compiledTransmux();
      return `export default function transmuxModule() {\n${code}\nreturn __transmux;\n}`;
    },
    generateBundle(_options, chunks) {
      const carries = Object.values(chunks).some(
        (chunk) => chunk.type === 'chunk' && chunk.moduleIds.includes(`\0${TRANSMUX_MODULE}`),
      );
      if (carries !== share) {
        throw new Error(
          `The bundle ${carries ? 'carries' : 'does not carry'} the transmux: correct WITH_TRANSMUX.`,
        );
      }
    },
  };
}

function bundle(input, file, share) {
  return {
    input,
    plugins: [shipTransmuxOnce(share)],
    output: { file, format: 'iife', name: 'mattebox', exports: 'default', minify: true },
    transform: {
      target: TARGET,
      // An IIFE has no `import.meta`; cdn/worker.ts supplies the Worker URL.
      define: { 'import.meta': '{}' },
    },
  };
}

export default defineConfig([
  bundle('cdn/full.ts', 'dist/cdn/mattebox.min.js', true),
  ...PRESETS.map((name) =>
    bundle(`cdn/${name}.ts`, `dist/cdn/mattebox.${name}.min.js`, WITH_TRANSMUX.has(name)),
  ),
]);
