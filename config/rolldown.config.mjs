import { defineConfig } from 'rolldown';

// CDN convenience bundle only — the primary artifact is the unbundled ESM in dist/.
export default defineConfig({
  input: 'src/index.ts',
  output: {
    file: 'dist/cdn/mattebox.min.js',
    format: 'iife',
    name: 'Mattebox',
    minify: true,
  },
});
