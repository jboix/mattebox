# Contributing to Mattebox

Thanks for contributing. Agents working in this repository also follow
[AGENTS.md](../AGENTS.md). Participation is governed by the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Setup

```sh
corepack enable
pnpm install
pnpm exec playwright install chromium firefox webkit   # browser and e2e tests
pnpm run verify    # everything CI checks
```

`verify` runs:

| Step                          | Tool                            | Checks                                                             |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| `pnpm run lint`               | Biome                           | Formatting and lint rules                                          |
| `pnpm run docs:check`         | remark                          | Markdown formatting, broken links and anchors                      |
| `pnpm run typecheck`          | tsc                             | Type errors                                                        |
| `pnpm run depcruise`          | dependency-cruiser              | Layer boundaries, cycles, zero runtime deps                        |
| `pnpm run knip`               | knip                            | Dead code, unused exports and dependencies                         |
| `pnpm run check:purity`       | scripts/check-kernel-purity.mjs | Nothing impure in the reducer                                      |
| `pnpm run test`               | Vitest                          | Node tests, and browser tests in real browsers                     |
| `pnpm run build`              | tsc + Rolldown                  | Modern ESM, types, ES2015 ESM, CDN bundles                         |
| `pnpm run check:emit`         | scripts/check-emit.mjs          | Banned TS constructs, bare import specifiers                       |
| `pnpm run check:side-effects` | scripts/side-effect-audit.mjs   | Import-time registrations                                          |
| `pnpm exec size-limit`        | size-limit                      | One budget: `mattebox.min.js` plus its Worker under 60 kB min+gzip |
| `pnpm run check:package`      | scripts/check-package.mjs       | publint and attw on every entry point                              |

`pnpm run test:e2e` runs the Playwright end-to-end tests. CI runs them too,
`verify` does not.

Requirements: Node 24 or later, pnpm via corepack (version pinned in
`packageManager`).

## Rules

Each of these is checked automatically or in review:

1. **Zero runtime dependencies.** Only MSE, EME, and standard web platform APIs.
   `dependency-cruiser` enforces this; do not add a dependency to work around a
   problem.
2. **Imports point down.** The kernel imports nothing above it. Protocols and
   containers import the kernel. Stages import the kernel and use `requires`
   for containers. **Stages never import each other.**
3. **No top-level side effects anywhere in `src/`.** Stage modules export a
   factory. Nothing registers at import time. This is what makes
   `sideEffects: false` true.
4. **The reducer is pure.** `reduce(state, msg)` returns the next state and a
   list of effects. No `await`, DOM, `fetch`, `Date.now()`, or `Math.random()`
   inside it. Effects are plain serializable data: no closures, promises, or
   DOM references.
5. **Commands and facts are different types.** A reducer may reject a command.
   It may **never** reject a fact.
6. **Never shadow a standard `HTMLMediaElement` member.** `currentTime`, `play()`,
   `buffered`, and the rest must keep working exactly as the browser defines them.
7. **Banned TypeScript:** non-const `enum`, `namespace`, parameter properties,
   decorators. The emit check catches violations.
8. **Protocol adapters emit the IR only.** No branching on content type to
   build special objects. Always emit `protection`, even when no DRM stage is
   loaded.
9. **Hot paths stay out of the message loop.** Byte processing is plain functions
   over `Uint8Array` called from effect handlers. Never dispatch per NAL unit or
   per PES packet.

## Commits

Conventional Commits. semantic-release reads the history when the Release
workflow is run, so the type is the version bump:

- `fix:` patch, `feat:` minor, `feat!:` or `BREAKING CHANGE:` major.
- `docs:`, `chore:`, `test:`, `refactor:` produce no release.

The subject is for the changelog. A body is required.

`pnpm install` sets up the git hooks through husky. `commit-msg` runs
commitlint, `pre-commit` runs Biome on the staged files and the docs check, and `pre-push` runs
`pnpm run verify`.

## Style

If `pnpm run verify` passes, the style is right. If you disagree with a
check, open an issue rather than arguing in the pull request.
