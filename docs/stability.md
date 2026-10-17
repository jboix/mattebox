# Stability and versions

Mattebox is at version 0.x. This page says what you can rely on now, what
version 1.0 promises, and what changes before it.

## Before 1.0

- A patch release, such as 0.14.1, fixes bugs. It changes no API.
- A minor release, such as 0.15.0, adds features. It can also change or
  remove an API. The release notes name the change.
- Use a tilde range, such as `~0.14.0`, if you review each minor release
  before you take it.

## The public API

You can rely on these, within the rules above:

| Surface                                                                                                                                                 | Where                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| The `mattebox()` factory and its options                                                                                                                | `mattebox`                                                           |
| The engine object: `attach`, `load`, `preload`, `unload`, `suspend`, `resume`, `on`, `quality`, `tracks`, `stats`, `error`, and the rest of its members | `mattebox`                                                           |
| The namespaces stages add, such as `engine.live` and `engine.catchup`                                                                                   | Each stage                                                           |
| Each stage factory and its options                                                                                                                      | `mattebox/stages/*`, `mattebox/protocols/*`, `mattebox/containers/*` |
| Each preset factory and its options                                                                                                                     | `mattebox/presets/*`                                                 |
| The EME attachment for native playback                                                                                                                  | `mattebox/eme`                                                       |
| Event names and payloads, error codes                                                                                                                   | [Chapter 09](guide/09-events-and-errors.md)                          |
| The CDN file names and the `mattebox` global                                                                                                            | [Chapter 14](guide/14-cdn.md)                                        |
| The trace export format, `exportTrace` and `replay`                                                                                                     | [Chapter 12](guide/12-diagnostics.md)                                |
| The browsers the engine runs in                                                                                                                         | [Chapter 13](guide/13-builds-and-targets.md#browser-support)         |

These are not a promise:

- The stages a preset contains. A minor release can add a stage to a
  preset or move one out, as 0.14 did with `cmcd`. Name a stage in
  `stages` if you depend on it.
- The bundle size of a preset.
- Anything you reach only through a type: kernel state, messages, and
  effects. They are exported so you can write a stage and replay a trace.

## What 1.0 promises

- Version numbers follow [Semantic Versioning](https://semver.org/). Only a
  major release changes or removes a public API.
- A deprecated API keeps working for at least two minor releases. Its type
  carries `@deprecated` with the replacement, and the release notes list
  it.
- A change to a default that changes what plays, such as an ABR default or
  the stages of a preset, counts as a change of API.
- The browser support in
  [chapter 13](guide/13-builds-and-targets.md#browser-support) holds for the
  whole major version.

## What changes before 1.0

These APIs are expected to change. Each change ships in a minor release.

| API                                              | Expected change                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `engine.dispatch(command)`                       | It accepts every kernel command today; 1.0 keeps only the ones the guide documents |
| `createReducer`, `initialState`, `resolveConfig` | They move to a separate entry point for trace replay and stage authors             |
| The exported kernel types                        | The root entry point keeps the types the public API uses; the rest moves with them |
| Stage authoring (`StageContext` and the IR)      | Stable within a major version from 1.0; until then it changes with new features    |

## Reporting a break

If a patch release breaks your page, or a minor release breaks it without a
note, [open an issue](https://github.com/jboix/mattebox/issues/new/choose).
That is a bug.
