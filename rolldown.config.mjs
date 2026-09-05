import { defineConfig, rolldown } from 'rolldown';

// CDN bundles: one minified IIFE per preset behind the `mattebox` global.
// The transmux Worker is compiled first and embedded as a string; cdn/worker.ts
// starts it from a blob URL, so a page loads one file.
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
];

// The package's default target, the same as dist/es2015.
const TARGET = 'es2015';

const WORKER_MODULE = 'virtual:transmux-worker';

let workerSource;
/** The Worker's minified source, compiled once per build. */
function transmuxWorkerSource() {
  workerSource ??= (async () => {
    const build = await rolldown({
      input: 'src/containers/ts-transmux/transmux.worker.ts',
      transform: { target: TARGET },
    });
    const { output } = await build.generate({ format: 'iife', minify: true });
    await build.close();
    return output[0].code;
  })();
  return workerSource;
}

/** `virtual:transmux-worker`: the Worker's source as a default export. */
const embedTransmuxWorker = {
  name: 'embed-transmux-worker',
  resolveId(id) {
    return id === WORKER_MODULE ? `\0${WORKER_MODULE}` : null;
  },
  async load(id) {
    if (id !== `\0${WORKER_MODULE}`) return null;
    return `export default ${JSON.stringify(await transmuxWorkerSource())};`;
  },
};

function bundle(input, file) {
  return {
    input,
    plugins: [embedTransmuxWorker],
    output: { file, format: 'iife', name: 'mattebox', exports: 'default', minify: true },
    transform: {
      target: TARGET,
      // An IIFE has no `import.meta`; cdn/worker.ts supplies the Worker URL.
      define: { 'import.meta': '{}' },
    },
  };
}

export default defineConfig([
  bundle('cdn/full.ts', 'dist/cdn/mattebox.min.js'),
  ...PRESETS.map((name) => bundle(`cdn/${name}.ts`, `dist/cdn/mattebox.${name}.min.js`)),
]);
