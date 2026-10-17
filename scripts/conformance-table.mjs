#!/usr/bin/env node
// Turns the conformance runs into the table in docs/guide/18-conformance.md.
// Each argument is a Vitest JSON report of test/e2e/conformance.test.ts in
// one browser, named conformance-<browser>.json. `--write` replaces the
// table in the guide; without it the table goes to stdout, for the CI job
// summary.
//
//   pnpm run test:conformance
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './lib/fail.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = join(ROOT, 'docs/guide/18-conformance.md');
const START = '<!-- conformance:start -->';
const END = '<!-- conformance:end -->';
const BROWSERS = ['chromium', 'firefox', 'webkit'];
const LABEL = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' };
const MARK = { passed: 'pass', failed: 'fail', skipped: 'no decoder', pending: 'no decoder' };

const args = process.argv.slice(2);
const write = args.includes('--write');
const files = args.filter((arg) => arg !== '--write');
if (files.length === 0) fail('name at least one conformance-<browser>.json report', []);

/** Stream title to browser to result. */
const rows = new Map();
for (const file of files) {
  const browser = /conformance-(\w+)\.json$/.exec(basename(file))?.[1];
  if (browser === undefined || !BROWSERS.includes(browser)) {
    fail(`${file} is not named conformance-<browser>.json`, []);
  }
  const report = JSON.parse(readFileSync(file, 'utf8'));
  for (const result of report.testResults ?? []) {
    for (const test of result.assertionResults ?? []) {
      const title = test.title.replace(/^conformance [\w-]+: /, '');
      if (!rows.has(title)) rows.set(title, {});
      rows.get(title)[browser] = MARK[test.status] ?? test.status;
    }
  }
}

const date = new Date().toISOString().slice(0, 10);
const header = `| Stream | ${BROWSERS.map((b) => LABEL[b]).join(' | ')} |`;
const rule = `| --- | ${BROWSERS.map(() => '---').join(' | ')} |`;
const body = [...rows].map(
  ([title, results]) =>
    `| ${title} | ${BROWSERS.map((b) => results[b] ?? 'not run').join(' | ')} |`,
);
const table = [`Run on ${date}.`, '', header, rule, ...body].join('\n');

if (!write) {
  console.log(table);
} else {
  const guide = readFileSync(GUIDE, 'utf8');
  const from = guide.indexOf(START);
  const to = guide.indexOf(END);
  if (from < 0 || to < from) fail(`${GUIDE} has no ${START} ... ${END} block`, []);
  writeFileSync(GUIDE, `${guide.slice(0, from + START.length)}\n\n${table}\n\n${guide.slice(to)}`);
  console.log(`wrote ${GUIDE}`);
}
