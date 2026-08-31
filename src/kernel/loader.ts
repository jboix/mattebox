/**
 * Stage composition: `requires` resolution into a topological install
 * order, with every conflict surfaced at composition time. Last-one-wins
 * and silent missing dependencies are how modular designs rot; here they
 * are errors with both names in the message.
 */
import type { Capability, Stage } from '../types/stage.js';
import { isManifestType, normalizeMimeType } from './mime.js';

/**
 * Names the kernel itself provides. A stage's `requires` naming one of
 * these is always satisfied; everything else must match a composed stage's
 * name or a capability it provides.
 */
export const KERNEL_PROVIDES: ReadonlySet<string> = new Set([
  'bus',
  'reducer',
  'effects',
  'trace',
  'mse',
  'append-queue',
  'evictor',
  'scheduler',
  'transport',
  'timeline',
  'track-registry',
  'rendition-select',
]);

function capabilityKey(capability: Capability): string {
  if (typeof capability === 'string') return capability;
  return `${capability.contentType}:${capability.mimeType}`;
}

/**
 * Capabilities that name a shared trait rather than a singleton service, so
 * more than one stage may provide them without conflict. `media-transform`
 * is the marker every byte-transform container (ts-transmux, packed-audio)
 * carries so the composition root knows to route media appends through the
 * transform pipeline; several such containers coexist by design.
 */
const SHARED_CAPABILITIES: ReadonlySet<string> = new Set([
  'media-transform',
  'media-time-normalized',
]);

export interface Composition {
  /** Stages in dependency order; install in this order, tear down reversed. */
  readonly order: readonly Stage[];
  /** Every capability the composition provides, deduplicated keys. */
  readonly capabilities: readonly Capability[];
  /**
   * The manifest MIME types the composed adapters parse, normalized. A
   * string capability containing '/' declares one; `engine.accepts` and the
   * pre-fetch LOAD check read this set.
   */
  readonly manifestTypes: ReadonlySet<string>;
}

/** Validates and orders a stage set. Throws on any composition error. */
export function compose(stages: readonly Stage[]): Composition {
  const byName = new Map<string, Stage>();
  for (const stage of stages) {
    if (byName.has(stage.name)) {
      throw new Error(`duplicate stage name '${stage.name}'`);
    }
    byName.set(stage.name, stage);
  }

  // Capability conflicts are composition errors, not last-one-wins.
  const capabilityOwners = new Map<string, string>();
  const capabilities: Capability[] = [];
  for (const stage of stages) {
    for (const capability of stage.provides ?? []) {
      const key = capabilityKey(capability);
      if (SHARED_CAPABILITIES.has(key)) {
        // A shared marker: many stages may carry it. Record the key once so
        // requires can resolve it, but never conflict on a second provider.
        if (!capabilityOwners.has(key)) {
          capabilityOwners.set(key, stage.name);
          capabilities.push(capability);
        }
        continue;
      }
      const owner = capabilityOwners.get(key);
      if (owner !== undefined && owner !== stage.name) {
        throw new Error(`'${owner}' and '${stage.name}' both provide '${key}'`);
      }
      if (owner === undefined) {
        capabilityOwners.set(key, stage.name);
        capabilities.push(capability);
      }
    }
  }

  function providerOf(requirement: string): Stage | 'kernel' | null {
    if (KERNEL_PROVIDES.has(requirement)) return 'kernel';
    const direct = byName.get(requirement);
    if (direct !== undefined) return direct;
    const owner = capabilityOwners.get(requirement);
    if (owner !== undefined) return byName.get(owner) ?? null;
    return null;
  }

  // Depth-first topological sort with cycle detection.
  const order: Stage[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  function visit(stage: Stage, path: readonly string[]): void {
    const mark = state.get(stage.name);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      throw new Error(`circular requires: ${[...path, stage.name].join(' -> ')}`);
    }
    state.set(stage.name, 'visiting');
    for (const requirement of stage.requires ?? []) {
      // An array requirement is a set of alternatives: the first one with a
      // provider wins. A plain string is a single hard dependency.
      const alternatives = Array.isArray(requirement) ? requirement : [requirement as string];
      let resolved: Stage | 'kernel' | null = null;
      for (const alternative of alternatives) {
        const provider = providerOf(alternative);
        if (provider !== null) {
          resolved = provider;
          break;
        }
      }
      if (resolved === null) {
        const names = alternatives.map((a) => `'${a}'`).join(' or ');
        throw new Error(`'${stage.name}' requires ${names}, which nothing provides`);
      }
      if (resolved !== 'kernel') visit(resolved, [...path, stage.name]);
    }
    state.set(stage.name, 'done');
    order.push(stage);
  }

  for (const stage of stages) {
    visit(stage, []);
  }

  const manifestTypes = new Set<string>();
  for (const capability of capabilities) {
    if (typeof capability === 'string' && isManifestType(capability)) {
      manifestTypes.add(normalizeMimeType(capability));
    }
  }

  return { order, capabilities, manifestTypes };
}
