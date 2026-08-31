/**
 * The effect runner. Takes inert effect descriptors, hands each to a
 * registered handler, and lets results re-enter the loop as facts.
 *
 * Handlers are injected, never imported. That is what keeps this module
 * node-testable: tests register fakes that record calls. An asynchronous
 * handler may return a cancel function; it is stored under the effect's
 * token, and an abort effect (or an explicit cancel call) invokes it.
 */
import type { Effect, Serializable } from '../types/messages.js';

export type EffectOf<K extends Effect['kind']> = Extract<Effect, { kind: K }>;

/** Handles one effect kind. A returned function cancels the started work. */
export type EffectHandler<K extends Effect['kind'] = Effect['kind']> = (
  effect: EffectOf<K>,
) => undefined | (() => void);

export interface CreateEffectRunnerOptions {
  /** Receives runner-internal events: unhandled kinds and throwing handlers. */
  readonly onEvent?: (event: string, payload: Serializable) => void;
}

export interface EffectRunner {
  register<K extends Effect['kind']>(kind: K, handler: EffectHandler<K>): void;
  run(effects: readonly Effect[]): void;
  /** Invokes and forgets the cancel function stored under the token, if any. */
  cancel(token: string): void;
  /** Drops the stored cancel without invoking it: the work under the token completed on its own. */
  forget(token: string): void;
  /** Cancels every pending token. The detach path: nothing started before it may fire after. */
  cancelAll(): void;
  /** Tokens with a live cancel function. For diagnostics and tests. */
  pending(): readonly string[];
}

export function createEffectRunner(options: CreateEffectRunnerOptions = {}): EffectRunner {
  const onEvent = options.onEvent ?? (() => undefined);
  const handlers = new Map<Effect['kind'], EffectHandler>();
  const cancels = new Map<string, () => void>();

  function cancel(token: string): void {
    const fn = cancels.get(token);
    if (fn === undefined) return;
    cancels.delete(token);
    try {
      fn();
    } catch (err) {
      onEvent('kernel:effect-error', { kind: 'abort', message: String(err) });
    }
  }

  return {
    register(kind, handler) {
      if (handlers.has(kind)) {
        throw new Error(`duplicate handler for '${kind}'`);
      }
      // The map erases the per-kind parameter; run() only ever hands a
      // handler the kind it was registered under.
      handlers.set(kind, handler as unknown as EffectHandler);
    },
    run(effects) {
      for (const effect of effects) {
        if (effect.kind === 'abort') {
          cancel(effect.token);
          // An abort handler is optional; the runner already did the work.
          handlers.get('abort')?.(effect);
          continue;
        }
        const handler = handlers.get(effect.kind);
        if (handler === undefined) {
          // An unhandled kind is an event, not a throw: a deployment without
          // the owning module must degrade, not crash.
          onEvent('kernel:effect-unhandled', { kind: effect.kind });
          continue;
        }
        try {
          const cancelFn = handler(effect);
          if (cancelFn !== undefined && 'token' in effect) {
            cancels.set(effect.token, cancelFn);
          }
        } catch (err) {
          onEvent('kernel:effect-error', { kind: effect.kind, message: String(err) });
        }
      }
    },
    cancel,
    forget(token) {
      cancels.delete(token);
    },
    cancelAll() {
      for (const token of [...cancels.keys()]) cancel(token);
    },
    pending() {
      return [...cancels.keys()];
    },
  };
}
