// Writes a SegmentList copy of a DASH flavor's MPD: each SegmentTemplate
// with a SegmentTimeline becomes a SegmentList that names every segment
// file, so the E2E suite plays SegmentList addressing on the same media.
//
// Usage: node gen-segmentlist.mjs <dash dir>
//   reads  <dir>/manifest.mpd
//   writes <dir>/manifest-list.mpd
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir] = process.argv.slice(2);
if (dir === undefined) {
  console.error('usage: node gen-segmentlist.mjs <dash dir>');
  process.exit(1);
}

const mpd = readFileSync(join(dir, 'manifest.mpd'), 'utf8');
const listed = mpd.replace(
  /<Representation id="([^"]+)"([^>]*)>\s*<SegmentTemplate ([^>]*)>\s*<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>\s*<\/SegmentTemplate>/g,
  (_, id, attributes, template, timeline) => {
    const get = (name) => new RegExp(`${name}="([^"]*)"`).exec(template)?.[1];
    const media = get('media');
    const start = Number(get('startNumber') ?? 1);
    let count = 0;
    for (const s of timeline.matchAll(/<S [^>]*d="(\d+)"(?: r="(\d+)")?/g))
      count += 1 + Number(s[2] ?? 0);
    const urls = [];
    for (let n = start; n < start + count; n += 1) {
      const name = media
        .replace('$RepresentationID$', id)
        .replace(/\$Number%0(\d+)d\$/, (_m, width) => String(n).padStart(Number(width), '0'))
        .replace('$Number$', String(n));
      urls.push(`\t\t\t\t\t<SegmentURL media="${name}"/>`);
    }
    const init = get('initialization').replace('$RepresentationID$', id);
    return `<Representation id="${id}"${attributes}>
				<SegmentList timescale="${get('timescale')}" startNumber="${start}">
					<Initialization sourceURL="${init}"/>
					<SegmentTimeline>${timeline}</SegmentTimeline>
${urls.join('\n')}
				</SegmentList>`;
  },
);
if (listed === mpd) throw new Error('no SegmentTemplate with a SegmentTimeline to rewrite');
writeFileSync(join(dir, 'manifest-list.mpd'), listed);
