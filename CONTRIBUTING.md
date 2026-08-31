# Contributing to Mattebox

Thanks for contributing. This document is for humans. Agents working in this
repository also follow [AGENTS.md](./AGENTS.md), and the non-negotiable rules
listed there bind all contributions. Participation is governed by the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Setup

```sh
corepack enable
pnpm install
pnpm exec playwright install chromium firefox webkit   # tier-3/4 tests
pnpm run verify    # the whole gate
```

`verify` runs the whole gate:

| Step                          | Tool                    | Checks                                          |
|-------------------------------|-------------------------|-------------------------------------------------|
| `pnpm run lint`               | Biome                   | Formatting and lint rules                       |
| `pnpm run typecheck`          | tsc                     | Type errors                                     |
| `pnpm run depcruise`          | dependency-cruiser      | Layer boundaries, cycles, zero runtime deps     |
| `pnpm run knip`               | knip                    | Dead code, unused exports and dependencies      |
| `pnpm run test`               | Vitest (node + browser) | Tiers 1–3, browser tier in real browsers        |
| `pnpm run build`              | tsc + Babel + Rolldown  | Modern ESM, legacy, CDN, declarations           |
| `pnpm run check:emit`         | scripts/check-emit.sh   | Banned TS constructs, bare import specifiers    |
| `pnpm run check:side-effects` | scripts/side-effect-audit.sh | Import-time registrations                  |
| `pnpm exec size-limit`        | size-limit              | Six per-configuration bundle budgets            |
| `pnpm run check:package`      | publint + attw          | Exports map and type resolution                 |

Requirements: Node 20.19 or later, pnpm via corepack (version pinned in
`packageManager`).

## The non-negotiable rules

Every one of these is enforced by an automated gate or will fail review:

1. **Zero runtime dependencies.** Only MSE, EME, and standard web platform APIs.
   `dependency-cruiser` enforces this; do not add a dependency to work around a
   problem.
2. **Dependencies point downward only.** Kernel → nothing. Protocols → kernel.
   Containers → kernel. Stages → kernel, and layer-2 modules via `requires`.
   **Stages never import each other.**
3. **No top-level side effects, anywhere in `src/`.** Stage modules export a
   factory. Nothing registers at import time. This is what makes
   `sideEffects: false` true, and the size budgets depend on it.
4. **The reducer is pure.** `reduce(state, msg) → [state, Effect[]]`. No `await`,
   no DOM, no `fetch`, no `Date.now()`, no `Math.random()` inside it. Effects are
   plain serializable data — no closures, no promises, no DOM references.
5. **Commands and facts are different types.** A reducer may reject a command.
   It may **never** reject a fact.
6. **Never shadow a standard `HTMLMediaElement` member.** `currentTime`, `play()`,
   `buffered`, and the rest must keep working exactly as the browser defines them.
7. **Banned TypeScript:** non-const `enum`, `namespace`, parameter properties,
   decorators. The emit check catches violations.
8. **Protocol adapters emit generic descriptors.** Never
   `if (contentType === 'text')` branching that constructs typed objects. Always
   emit a `protection` field, even when no DRM stage exists.
9. **Hot paths stay out of the message loop.** Byte processing is plain functions
   over `Uint8Array` called from effect handlers. Never dispatch per NAL unit or
   per PES packet.

## Commits

Conventional Commits. semantic-release cuts releases from the commit history
(via the manually dispatched Release workflow), so the type you choose is the
version bump you cause:

- `fix:` patch, `feat:` minor, `feat!:` or `BREAKING CHANGE:` major.
- `docs:`, `chore:`, `test:`, `refactor:` produce no release.

Write the subject line for the changelog reader, not the diff reader.

## Style

- Biome owns formatting and lint.
- Explicit `.js` extensions in all import specifiers.
- `import type` for type-only imports.
- Comments explain **why**. Cite spec sections: `// RFC 8216 §4.3.2.2`.
- Prefer `Map` over object literals for keyed state that churns.
- No barrel files inside `src/kernel/`.

If `pnpm run verify` passes, the style is right. Do not argue with a check in a
pull request; open an issue instead.

## Pull requests

Keep them scoped to one change. CI runs the same `verify` chain in the Quality
workflow, plus browser and E2E tiers. A pull request merges with a green run
and a review from a main contributor.
