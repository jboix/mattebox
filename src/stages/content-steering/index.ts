/**
 * Content steering: pathway switching from a steering manifest, plus
 * failover when the active pathway starts failing. The two manifest
 * families normalize into one model at parse time — HLS pathways are
 * variant clones (renditions carry a pathway id), DASH pathways are
 * BaseURL choices (the steering bases map) — so one stage serves both:
 * rendition pathways apply through a 'steering' constraint, base pathways
 * through a transport request hook rewriting URL prefixes.
 */
import type { KernelState, SliceReducer } from '../../types/kernel.js';
import type { Effect, Message } from '../../types/messages.js';
import type { Stage } from '../../types/stage.js';

const MANIFEST_TOKEN = 'steering:manifest';
const RELOAD_TOKEN = 'steering:reload';
const PATHWAY_EVENT = 'steering:pathway';

/** Failures on the active pathway before failing over. */
const FAILOVER_AFTER = 2;
/** Default steering manifest TTL, in seconds. */
const DEFAULT_TTL = 300;

interface SteeringSlice {
  readonly serverUri: string | null;
  /** Pathway ids in priority order, from the steering manifest. */
  readonly priority: readonly string[];
  readonly active: string | null;
  /** Pathways declared dead by failover until the next steering reload. */
  readonly dead: readonly string[];
  readonly fails: number;
  readonly fetchPending: boolean;
  readonly tickPending: boolean;
}

const INITIAL: SteeringSlice = {
  serverUri: null,
  priority: [],
  active: null,
  dead: [],
  fails: 0,
  fetchPending: false,
  tickPending: false,
};

/** Loops a message back into the bus through a zero-delay schedule effect. */
function feed(message: Message): Effect {
  // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
  return { kind: 'schedule', token: 'steering:loopback', delayMs: 0, then: message };
}

function pathwaysOf(kernel: Readonly<KernelState>): readonly string[] {
  const ids = new Set<string>();
  for (const base of Object.keys(kernel.presentation?.steering?.bases ?? {})) ids.add(base);
  for (const period of kernel.presentation?.periods ?? []) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        if (rendition.pathway !== undefined) ids.add(rendition.pathway);
      }
    }
  }
  return [...ids];
}

/** The effects that make `active` the pathway in force. */
function applyPathway(kernel: Readonly<KernelState>, active: string): readonly Effect[] {
  const effects: Effect[] = [{ kind: 'emit', event: PATHWAY_EVENT, payload: { pathway: active } }];
  // Rendition-cloned pathways: exclude every rendition on another pathway.
  const excludeIds: string[] = [];
  for (const period of kernel.presentation?.periods ?? []) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        if (rendition.pathway !== undefined && rendition.pathway !== active) {
          excludeIds.push(rendition.id);
        }
      }
    }
  }
  effects.push(
    excludeIds.length > 0
      ? feed({ type: 'CONSTRAIN', source: 'steering', constraint: { excludeIds } })
      : feed({ type: 'RELEASE_CONSTRAINT', source: 'steering' }),
  );
  return effects;
}

function choosePathway(slice: SteeringSlice, known: readonly string[]): string | null {
  for (const id of slice.priority) {
    if (!slice.dead.includes(id) && known.includes(id)) return id;
  }
  return known.find((id) => !slice.dead.includes(id)) ?? null;
}

const reduceSteering: SliceReducer<SteeringSlice> = (slice, msg, kernel) => {
  const state = slice ?? INITIAL;

  if (msg.type === 'LOAD' || msg.type === 'UNLOAD' || msg.type === 'DETACH') {
    return [INITIAL, []];
  }

  if (msg.type === 'MANIFEST_LOADED') {
    const steering = msg.presentation.steering;
    if (steering === undefined) return [state, []];
    const effects: Effect[] = [];
    let next = state;
    if (state.serverUri === null) {
      next = {
        ...next,
        serverUri: steering.serverUri,
        active: steering.defaultPathway ?? null,
      };
      effects.push({ kind: 'fetch', token: MANIFEST_TOKEN, url: steering.serverUri });
      next = { ...next, fetchPending: true };
      if (next.active !== null) {
        effects.push(...applyPathway(kernel, next.active));
      }
    }
    return [next, effects];
  }

  if (msg.type === 'SEGMENT_LOADED' && msg.trackId === MANIFEST_TOKEN) {
    let parsed: { TTL?: number; 'RELOAD-URI'?: string; 'PATHWAY-PRIORITY'?: string[] };
    try {
      parsed = JSON.parse(new TextDecoder().decode(msg.bytes)) as typeof parsed;
    } catch {
      return [{ ...state, fetchPending: false }, []];
    }
    const priority = parsed['PATHWAY-PRIORITY'] ?? [];
    // A fresh steering manifest amnesties the dead list.
    let next: SteeringSlice = { ...state, priority, dead: [], fails: 0, fetchPending: false };
    const effects: Effect[] = [];
    const chosen = choosePathway(next, pathwaysOf(kernel));
    if (chosen !== null && chosen !== state.active) {
      next = { ...next, active: chosen };
      effects.push(...applyPathway(kernel, chosen));
    }
    if (!next.tickPending) {
      effects.push({
        kind: 'schedule',
        token: RELOAD_TOKEN,
        delayMs: (parsed.TTL ?? DEFAULT_TTL) * 1000,
        // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
        then: { type: 'TICK', token: RELOAD_TOKEN },
      });
      next = { ...next, tickPending: true };
    }
    return [next, effects];
  }

  if (msg.type === 'TICK' && msg.token === RELOAD_TOKEN) {
    if (state.serverUri === null) return [{ ...state, tickPending: false }, []];
    return [
      { ...state, tickPending: false, fetchPending: true },
      [{ kind: 'fetch', token: MANIFEST_TOKEN, url: state.serverUri }],
    ];
  }

  if (msg.type === 'SEGMENT_FAILED' && msg.renditionId !== undefined && state.active !== null) {
    // Failures on the active pathway accumulate toward failover.
    const fails = state.fails + 1;
    if (fails < FAILOVER_AFTER) return [{ ...state, fails }, []];
    const dead = [...state.dead, state.active];
    const next: SteeringSlice = { ...state, dead, fails: 0 };
    const chosen = choosePathway(next, pathwaysOf(kernel));
    if (chosen === null || chosen === state.active) return [next, []];
    return [
      { ...next, active: chosen },
      [
        { kind: 'emit', event: 'steering:failover', payload: { from: state.active, to: chosen } },
        ...applyPathway(kernel, chosen),
      ],
    ];
  }

  return [state, []];
};

/** The stage factory. */
export default function contentSteering(): Stage {
  return {
    name: 'content-steering',
    provides: ['content-steering'],
    requires: ['transport'],
    install(ctx) {
      ctx.reduce('steering', reduceSteering as SliceReducer);
      // Base-URL pathways (DASH) rewrite at the transport boundary; the
      // slice announces the active pathway and this closure applies it.
      let activeBase: string | null = null;
      let bases: Readonly<Record<string, string>> = {};
      ctx.on(PATHWAY_EVENT, (payload) => {
        const pathway = (payload as { pathway?: string }).pathway;
        bases = ctx.getState().presentation?.steering?.bases ?? {};
        activeBase = pathway !== undefined ? (bases[pathway] ?? null) : null;
      });
      ctx.addRequestHook((req) => {
        if (activeBase === null) return;
        for (const base of Object.values(bases)) {
          if (base !== activeBase && req.url.startsWith(base)) {
            req.url = activeBase + req.url.slice(base.length);
            return;
          }
        }
      });
    },
  };
}
