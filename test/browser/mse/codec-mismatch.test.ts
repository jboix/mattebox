import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '../../../src/types/messages.js';
import {
  attachAndOpen,
  createBufferAndWait,
  createStack,
  type Stack,
  VIDEO_VP9,
  waitFor,
} from './helpers.js';

/**
 * A failed append names the type the buffer was created with and the type
 * the probe read from the init segment, when they differ: the diagnosis of a
 * manifest that declared the wrong codec.
 */

const PROBED = 'video/mp4; codecs="vp09.02.30.10"';
const stacks: Stack[] = [];
afterEach(() => {
  for (const stack of stacks.splice(0)) stack.controller.detach();
});

/** Bytes the parser rejects; the stub probe reads them as an init segment of `probed`. */
async function failAppend(probed: string | null): Promise<Message | undefined> {
  const stack = createStack({ inferType: (bytes) => (bytes[0] === 0xaa ? probed : null) });
  stacks.push(stack);
  await attachAndOpen(stack);
  await createBufferAndWait(stack, 'video', VIDEO_VP9);
  const garbage = new Uint8Array(64).fill(0xaa).buffer;
  stack.runner.run([{ kind: 'append', sbId: 'video', data: garbage }]);
  await waitFor(() => stack.hasFact('SOURCEBUFFER_ERROR'), 'append error');
  return stack.facts('SOURCEBUFFER_ERROR')[0];
}

describe('a failed append carries the declared and probed types', () => {
  it('names both when the probe read another codec', async () => {
    const fact = await failAppend(PROBED);
    if (fact?.type !== 'SOURCEBUFFER_ERROR') throw new Error('expected a SOURCEBUFFER_ERROR');
    expect(fact.error.code).toBe('MEDIA_APPEND_FAILED');
    expect(fact.error.context).toMatchObject({ declaredType: VIDEO_VP9, probedType: PROBED });
  });

  it('names neither when the probe agrees with the declared type', async () => {
    const fact = await failAppend(VIDEO_VP9);
    if (fact?.type !== 'SOURCEBUFFER_ERROR') throw new Error('expected a SOURCEBUFFER_ERROR');
    expect(fact.error.context?.declaredType).toBeUndefined();
  });
});
