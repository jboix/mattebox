/**
 * The element-size cap from docs/08, verbatim: a ResizeObserver feeding one
 * named constraint source. Its size is the litmus test for the constraint
 * API; if this file grows, the API is wrong.
 */
import type { Stage } from '../../types/stage.js';

export default function abrCapSize(): Stage {
  return {
    name: 'abr-cap-size',
    requires: ['rendition-select'],
    install(ctx) {
      const observer = new ResizeObserver(([entry]) => {
        if (entry === undefined) return;
        const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
        ctx.dispatch({
          type: 'CONSTRAIN',
          source: 'element-size',
          constraint: { maxHeight: entry.contentRect.height * dpr },
        });
      });
      observer.observe(ctx.element);
      return () => observer.disconnect();
    },
  };
}
