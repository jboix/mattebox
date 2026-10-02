// Writes a three-period copy of a DASH flavor's MPD for the E2E suite:
// the content from 0 to 12 s, an "ad" from 12 to 20 s, and the content
// again from 20 s. The ad is the 480x270 rung's first two segments: another
// media clock (it starts at 0) and another init, in the same codec family,
// so playback crosses both boundaries through a discontinuity and an init
// change.
//
// Usage: node gen-multiperiod.mjs <dash dir>
//   reads  <dir>/manifest.mpd
//   writes <dir>/manifest-periods.mpd
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir] = process.argv.slice(2);
if (dir === undefined) {
  console.error('usage: node gen-multiperiod.mjs <dash dir>');
  process.exit(1);
}

const mpd = readFileSync(join(dir, 'manifest.mpd'), 'utf8');
const set = /<AdaptationSet[^>]*contentType="video"[\s\S]*?<\/AdaptationSet>/.exec(mpd)?.[0];
if (set === undefined) throw new Error('no video AdaptationSet');
const timescale = Number(/timescale="(\d+)"/.exec(set)?.[1]);
const d = Number(/<S t="0" d="(\d+)"/.exec(set)?.[1]);
const count = Number(/<S t="0" d="\d+" r="(\d+)"/.exec(set)?.[1]) + 1;
const seconds = d / timescale;

/** The set with every Representation's timeline replaced. */
const withTimeline = (from, n, pto) =>
  set
    .replace(
      /startNumber="1"/g,
      `startNumber="${from}"${pto > 0 ? ` presentationTimeOffset="${pto}"` : ''}`,
    )
    .replace(/<S t="0" d="(\d+)" r="\d+" \/>/g, `<S t="${(from - 1) * d}" d="$1" r="${n - 1}" />`);

const firstEnd = 3; // segments 1 to 3: 0 to 12 s
const adCount = 2; // 8 s of ad
const resume = firstEnd + adCount + 1; // the content resumes at its own segment 6, 20 s
const content1 = withTimeline(1, firstEnd, 0);
const ad = set
  .replace(/id="0"/, 'id="ad"')
  .replace(/<Representation id="0"[\s\S]*?<\/Representation>/, '')
  .replace(/<Representation id="2"[\s\S]*?<\/Representation>/, '')
  .replace(/<S t="0" d="(\d+)" r="\d+" \/>/g, `<S t="0" d="$1" r="${adCount - 1}" />`);
const content2 = withTimeline(resume, count - resume + 1, (resume - 1) * d);

const periods = `	<Period id="content-1" start="PT0S" duration="PT${firstEnd * seconds}S">
		${content1}
	</Period>
	<Period id="ad" duration="PT${adCount * seconds}S">
		${ad}
	</Period>
	<Period id="content-2" duration="PT${(count - resume + 1) * seconds}S">
		${content2}
	</Period>`;
writeFileSync(
  join(dir, 'manifest-periods.mpd'),
  mpd.replace(/\t<Period[\s\S]*<\/Period>/, periods),
);
