# AGENTS.md — Standing instructions for Mattebox

Place this at the repository root. It applies to every stage.

---

## What this project is

**Mattebox** is a modular adaptive-streaming engine for HLS and DASH, built as a lean replacement for `videojs-http-streaming`. It is a kernel plus independently loadable **stages**. Read the architecture overview in the design record before doing anything.

> The design record (`docs/`) is maintained locally by the project owner and is
> not part of the repository. References to design docs below apply when
> working with that local record.

## Non-negotiable rules

1. **Zero runtime dependencies.** Only MSE, EME, and standard web platform APIs. `dependency-cruiser` enforces this; do not add a dependency to work around a problem.

2. **Dependencies point downward only.** Kernel → nothing. Protocols → kernel. Containers → kernel. Stages → kernel, and layer-2 modules via `requires`. **Stages never import each other.**

3. **No top-level side effects, anywhere in `src/`.** Stage modules export a factory. Nothing registers at import time. This is what makes `sideEffects: false` true, and the size budgets depend on it.

4. **The reducer is pure.** `reduce(state, msg) → [state, Effect[]]`. No `await`, no DOM, no `fetch`, no `Date.now()`, no `Math.random()` inside it. Effects are plain serializable data — no closures, no promises, no DOM references.

5. **Commands and facts are different types.** A reducer may reject a command. It may **never** reject a fact.

6. **Never shadow a standard `HTMLMediaElement` member.** `currentTime`, `play()`, `buffered`, and the rest must keep working exactly as the browser defines them.

7. **Banned TypeScript:** non-const `enum`, `namespace`, parameter properties, decorators. The emit check enforces this.

8. **Protocol adapters emit generic descriptors.** Never `if (contentType === 'text')` branching that constructs typed objects. Always emit a `protection` field, even when no DRM stage exists.

9. **Hot paths stay out of the message loop.** Byte processing is plain functions over `Uint8Array` called from effect handlers. Never dispatch per NAL unit or per PES packet.

## Before writing code

- Read the layer document for the layer you are working in.
- Read the entanglements design doc. If your task touches captions, ABR, DRM, or text scheduling, the coupling is already documented and has a prescribed resolution.
- Check whether the types you need already exist in `src/types/`. Stage 01 defined the whole surface; do not invent parallel types.

## While writing code

- Explicit `.js` extensions in all import specifiers.
- `import type` for type-only imports.
- Comments explain **why**. Cite spec sections: `// RFC 8216 §4.3.2.2`.
- Prefer `Map` over object literals for keyed state that churns.
- No barrel files inside `src/kernel/`.

## Writing

Documentation, comments, commit messages, and user-facing strings use direct language.

- Write plain declarative sentences. State the fact, then at most one sentence of why.
- No em-dashes. Use commas, colons, parentheses, periods.
- No rambling, aphorisms, or clever turns. No "X is what makes Y"; write the fact or "Y because X".
- No idioms or unusual verbs. Name things for what they are. No cute jargon.
- One fact per bullet. Paragraphs of one to three short sentences.
- Reference docs carry no essays. A one-line table entry is the documentation; add a section only when asked.

## Before declaring a stage complete

Run every gate and paste the **actual output** into the handoff report:

```bash
pnpm biome ci .
pnpm tsc --noEmit
pnpm depcruise src --config config/dependency-cruiser.cjs
pnpm knip
pnpm vitest run --project=node
pnpm vitest run --project=browser     # from Stage 03 onward
pnpm build && ./scripts/check-emit.sh && ./scripts/side-effect-audit.sh
pnpm size-limit
```

## Handoff report format

End every stage with:

```markdown
## Stage NN Handoff

### Built
<file-by-file summary>

### Definition of Done
- [x] item — evidence
- [ ] item — why not

### Deviations from docs
<what, why, and whether docs need updating>

### Decisions not covered by docs
<anything you had to choose; flag for human review>

### Gate output
<actual command output, pasted>

### Blockers for the next stage
<what does not yet exist that Stage NN+1 needs>
```

## Scope discipline

**Do not build ahead.** If a stage prompt says "types only, no implementation", write no implementation. If it says "kernel core, node-only", do not touch the DOM. Stages exist so a human can review incrementally; building ahead defeats that and makes review impossible.

If you believe a stage's scope is wrong, say so in the handoff report and stop. Do not expand scope unilaterally.

## When the docs are wrong or silent

The docs are a design record, not scripture — but they encode reasons that are often non-obvious. If something seems wrong:

1. Check the conversation-memory design doc — the option may have been considered and rejected for a reason.
2. If still wrong, implement what you believe is correct, and **document the deviation prominently** in the handoff report.
3. Never silently deviate.
