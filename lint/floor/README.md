# The TV floor rules

A Biome plugin that fails the lint on browser APIs newer than Chromium 76,
the floor of AGENTS.md rule 10. Chromium 76 is Samsung Tizen 6.0, the 2021
sets; LG webOS 6 is Chromium 79.

`biome.json` loads `js.grit` for `src`. The playground and the tests run in
current browsers and are not checked.

Biome's own `useBaseline` rule does not do this job. It targets Baseline,
which follows every major browser, not Chromium 76.

## Rules

| Call                            | Needs        | Instead                                      |
| ------------------------------- | ------------ | -------------------------------------------- |
| `node.replaceChildren(…)`       | Chromium 86  | Remove the children in a loop, then append   |
| `text.replaceAll(a, b)`         | Chromium 85  | `replace()` with a global regular expression |
| `list.at(index)`                | Chromium 92  | `list[list.length - n]`                      |
| `structuredClone(value)`        | Chromium 98  | A copy by hand                               |
| `Object.hasOwn(object, key)`    | Chromium 93  | `Object.prototype.hasOwnProperty.call()`     |
| `findLast()`, `findLastIndex()` | Chromium 97  | A loop from the end                          |
| `toSorted()`, `toReversed()`    | Chromium 110 | `sort()` or `reverse()` on a copy            |
| `Promise.any(list)`             | Chromium 85  | `Promise.all` over caught promises           |
| `AbortSignal.timeout(ms)`       | Chromium 103 | An `AbortController` and `setTimeout`        |
| `node.checkVisibility()`        | Chromium 105 | `getClientRects().length > 0`                |

Syntax such as `?.` and `??` is not checked. The default build lowers it to
ES2015.

## Adding a rule

The file is one GritQL `or`, and each branch registers its own diagnostic:

```grit
`structuredClone($value)` as $m where {
  register_diagnostic(span=$m, message="structuredClone() needs Chromium 98. …")
}
```

Regular expressions in GritQL bind a variable for each capturing group, so
write groups as `(?:…)`.

The player repository carries the same rules, and CSS rules beside them.
Change a rule in both.
