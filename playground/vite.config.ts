import type { CSSOptions } from 'vite';
import { defineConfig } from 'vite';

/** A PostCSS plugin, as Vite's own options name it: postcss is not a direct dependency. */
type PostcssPlugin = NonNullable<
  Exclude<CSSOptions['postcss'], string | undefined>['plugins']
>[number];

/** The few parts of a PostCSS node this step reads. */
interface CssNode {
  type: string;
  prop?: string;
  value?: string;
  selector?: string;
  selectors?: string[];
  each(fn: (node: CssNode) => void): void;
  after(css: string): void;
}

/**
 * Flex `gap` needs Chromium 84, and the hosted playground runs on the TV
 * floor, Chromium 76. For each flex rule with a gap, this adds the same
 * space as margins under `.no-flex-gap`, which the page sets where the
 * browser lacks flex gap. Current browsers keep the gap and never match.
 */
function flexGapFallback(): PostcssPlugin {
  const plugin = {
    postcssPlugin: 'flex-gap-fallback',
    Once(root: { walkRules(fn: (rule: CssNode) => void): void }) {
      root.walkRules((rule) => {
        if (rule.selector?.startsWith('.no-flex-gap') === true) return;
        let display = '';
        let direction = 'row';
        let wrap = false;
        let gap = '';
        rule.each((node) => {
          if (node.type !== 'decl') return;
          if (node.prop === 'display') display = node.value ?? '';
          if (node.prop === 'flex-direction') direction = node.value ?? '';
          if (node.prop === 'flex-wrap' || node.prop === 'flex-flow') {
            wrap = (node.value ?? '').includes('wrap');
          }
          if (node.prop === 'gap') gap = node.value ?? '';
        });
        if (!display.includes('flex') || gap === '') return;
        const [rowGap = '0', columnGap = rowGap] = gap.split(/\s+/);
        if (parseFloat(rowGap) === 0 && parseFloat(columnGap) === 0) return;
        const under = (tail: string): string =>
          (rule.selectors ?? []).map((s) => `.no-flex-gap ${s} > ${tail}`).join(', ');
        if (direction.startsWith('column')) {
          rule.after(`${under(':not(:last-child)')} { margin-bottom: ${rowGap}; }`);
          return;
        }
        if (wrap) rule.after(`${under('*')} { margin-bottom: ${rowGap}; }`);
        // An only child is spaced too: a label's checkbox has its text after it.
        rule.after(
          `${under(':not(:last-child)')}, ${under(':only-child')} { margin-right: ${columnGap}; }`,
        );
      });
    },
  };
  return plugin as unknown as PostcssPlugin;
}

// The playground imports src/ directly so HMR works against source, and
// serves the generated E2E streams as its local corpus.
//
// `--mode pages` produces the hosted build. It has no public dir, because
// the fixtures beside the corpus are test data; the GitHub Pages workflow
// generates the corpus and copies `test/fixtures/streams` into the built
// site instead. Pass `--base` for the subpath the build is served from.
export default defineConfig(({ mode }) => ({
  publicDir: mode === 'pages' ? false : '../test/fixtures',
  server: {
    fs: { allow: ['..'] },
  },
  css: {
    postcss: { plugins: [flexGapFallback()] },
  },
  build: {
    // The hosted playground is lowered to the same target as the package's
    // default build, so a deployment exercises what users ship.
    target: 'es2015',
  },
}));
