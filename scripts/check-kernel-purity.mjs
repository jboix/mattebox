// No browser APIs in the pure kernel core, no protocol names anywhere in the kernel.
import { globSync, readFileSync } from 'node:fs';
import { fail } from './lib/fail.mjs';

const CORE = [
  'src/kernel/bus.ts',
  'src/kernel/reducer.ts',
  'src/kernel/effects.ts',
  'src/kernel/trace.ts',
];
const BROWSER_API = /window|document|MediaSource|HTMLMediaElement|fetch\(/;
const PROTOCOL = /hls|dash|m3u8|mpd/i;

/** `file:line: text` for every matching line, like `grep -n`. */
function grep(files, pattern) {
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        pattern.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [],
      ),
  );
}

const browserHits = grep(CORE, BROWSER_API);
if (browserHits.length > 0) fail('browser API reference in the pure kernel core', browserHits);

const protocolHits = grep(globSync('src/kernel/**/*.ts').sort(), PROTOCOL);
if (protocolHits.length > 0) fail('protocol reference in the kernel', protocolHits);

console.log('kernel purity check passed');
