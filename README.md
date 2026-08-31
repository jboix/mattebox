# Mattebox

[![Quality](https://github.com/jboix/mattebox/actions/workflows/quality.yml/badge.svg)](https://github.com/jboix/mattebox/actions/workflows/quality.yml)
[![node](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Mattebox is a modular adaptive-streaming engine for HLS and DASH. It is a kernel
plus independently loadable stages. A deployment bundles only the stages it
streams; unused features are absent from the build, not disabled at runtime.

- Zero runtime dependencies. The engine uses only MSE, EME, and standard web
  platform APIs.
- One engine for both protocols. HLS and DASH differ only in manifest syntax
  when content is CMAF, so two parsers share one scheduler.
- Enforced size budgets. Each supported configuration has a bundle-size limit
  that fails CI when exceeded.
- Three build outputs: unbundled ES2022 ESM as the primary artifact, a Babel
  build for TVs, and a CDN bundle.

Standing instructions for agents and contributors: [AGENTS.md](./AGENTS.md) and
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Development

```bash
corepack enable
pnpm install
pnpm exec playwright install chromium firefox webkit   # needed for browser and E2E tests

pnpm test            # all Vitest projects
pnpm build           # dist/ (modern ESM), dist/legacy/, dist/cdn/, .d.ts
pnpm run verify      # the whole quality gate
```

CI runs the same gates as `pnpm run verify`. Run them locally before pushing;
they are fast.

## License

[MIT](./LICENSE) © Josep Boix Requesens
