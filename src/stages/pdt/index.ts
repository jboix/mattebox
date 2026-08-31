/**
 * Wall clock to media time and back, from whichever anchor the manifest
 * offers: EXT-X-PROGRAM-DATE-TIME or availabilityStartTime. Two pure
 * conversions over kernel state; resist making it more.
 */
import type { KernelState } from '../../types/kernel.js';
import type { Stage } from '../../types/stage.js';

declare module '../../index.js' {
  interface MatteboxNamespaces {
    pdt: PdtApi;
  }
}

export interface PdtApi {
  /** Presentation time to epoch seconds, or null without an anchor. */
  toWallClock(presentationTime: number): number | null;
  /** Epoch seconds to presentation time, or null without an anchor. */
  toPresentationTime(wallClock: number): number | null;
}

function anchorOf(
  state: Readonly<KernelState>,
): { wallClock: number; presentationTime: number } | null {
  const live = state.presentation?.live;
  if (live?.dateAnchor !== undefined) return live.dateAnchor;
  if (live?.availabilityStart !== undefined) {
    return { wallClock: live.availabilityStart, presentationTime: 0 };
  }
  return null;
}

export default function pdt(): Stage {
  return {
    name: 'pdt',
    provides: ['pdt'],
    requires: ['timeline'],
    install(ctx) {
      const api: PdtApi = {
        toWallClock(presentationTime) {
          const anchor = anchorOf(ctx.getState());
          if (anchor === null) return null;
          return anchor.wallClock + (presentationTime - anchor.presentationTime);
        },
        toPresentationTime(wallClock) {
          const anchor = anchorOf(ctx.getState());
          if (anchor === null) return null;
          return anchor.presentationTime + (wallClock - anchor.wallClock);
        },
      };
      ctx.registerNamespace('pdt', api);
    },
  };
}
