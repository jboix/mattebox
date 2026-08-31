/**
 * Deterministic bad networks, through the engine's transport config: a
 * fetchImpl wrapper for outcomes the network owns (status, stall, latency,
 * throughput) and nothing global is intercepted.
 */

export interface FaultConfig {
  /** Bits per second cap; the response is delayed to simulate it. 0 = off. */
  bandwidthBps: number;
  /** A scripted profile overrides the fixed cap while it runs. */
  profile: 'none' | 'step-down' | 'sawtooth' | 'collapse-recover';
  latencyMs: number;
  /** Force this HTTP status... */
  forceStatus: number;
  /** ...on every Nth request whose URL matches `match`. 0 = off. */
  forceEveryNth: number;
  match: string;
  /** Accept the request, never respond. */
  stall: boolean;
  failManifests: boolean;
}

export function defaultFaults(): FaultConfig {
  return {
    bandwidthBps: 0,
    profile: 'none',
    latencyMs: 0,
    forceStatus: 503,
    forceEveryNth: 0,
    match: '',
    stall: false,
    failManifests: false,
  };
}

function profileBps(profile: FaultConfig['profile'], elapsedSeconds: number): number {
  switch (profile) {
    case 'step-down':
      return elapsedSeconds < 10 ? 4_000_000 : elapsedSeconds < 20 ? 1_000_000 : 300_000;
    case 'sawtooth': {
      const phase = elapsedSeconds % 20;
      return 300_000 + (phase / 20) * 3_700_000;
    }
    case 'collapse-recover': {
      const phase = elapsedSeconds % 30;
      return phase < 10 ? 4_000_000 : phase < 18 ? 0 : 4_000_000;
    }
    default:
      return 0;
  }
}

export function createFaultyFetch(config: FaultConfig): {
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  counters: Map<string, number>;
} {
  const counters = new Map<string, number>();
  const started = Date.now();

  async function fetchImpl(url: string, init: RequestInit): Promise<Response> {
    const isManifest = url.includes('.m3u8') || url.includes('.mpd');
    const matches = config.match === '' || url.includes(config.match);

    if (config.stall && matches && !isManifest) {
      // Accept and never respond; only an abort releases it.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('stalled request aborted', 'AbortError')),
        );
      });
    }
    if (config.failManifests && isManifest) {
      const count = (counters.get('manifest') ?? 0) + 1;
      counters.set('manifest', count);
      if (count > 1) return new Response(null, { status: 503 });
    }
    if (config.forceEveryNth > 0 && matches) {
      const key = `nth:${config.match}`;
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      if (count % config.forceEveryNth === 0) {
        return new Response(null, { status: config.forceStatus });
      }
    }
    if (config.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.latencyMs));
    }

    const response = await fetch(url, init);
    const bps =
      config.profile !== 'none'
        ? profileBps(config.profile, (Date.now() - started) / 1000)
        : config.bandwidthBps;
    if (bps > 0 && response.ok) {
      const bytes = (await response.clone().arrayBuffer()).byteLength;
      const transferMs = (bytes * 8000) / bps;
      await new Promise((resolve) => setTimeout(resolve, transferMs));
    } else if (config.profile === 'collapse-recover' && bps === 0) {
      // Total collapse: behave like a dead network.
      throw new TypeError('network collapsed (playground profile)');
    }
    return response;
  }

  return { fetchImpl, counters };
}
