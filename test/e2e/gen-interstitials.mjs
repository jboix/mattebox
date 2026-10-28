// Writes the playlists and MPDs that schedule breaks over a flavor's
// media, for the interstitials stage: the content is the flavor's lowest
// rung and its English audio, the break is the ad clip ads_flavor encodes
// (8 s of colour bars and a tone).
//
//   <flavor>-interstitials/master.m3u8       a pre-roll, a mid-roll at 20 s that
//                                             inserts, one at 40 s that replaces
//                                             8 s and takes no skip and no jump,
//                                             and a post-roll
//   <flavor>-interstitials/master-list.m3u8  an asset list of two ads at 20 s
//   <flavor>-interstitials/master-cue.m3u8   an EXT-X-CUE-OUT from 24 to 32 s
//   <flavor>-interstitials/master-scte35.m3u8 an EXT-X-DATERANGE with SCTE35-OUT at
//                                             24 s, closed by its END-DATE at 32 s
//   <flavor>-dash/manifest-interstitials.mpd an insert at 20 s and a replace at
//                                             40 s, as DASH alternative MPD events
//
// Usage: node gen-interstitials.mjs <streams dir> <flavor>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [out, flavor] = process.argv.slice(2);
if (out === undefined || flavor === undefined) {
  console.error('usage: node gen-interstitials.mjs <streams dir> <flavor>');
  process.exit(1);
}

const dir = join(out, `${flavor}-interstitials`);
mkdirSync(dir, { recursive: true });
const ad = `../ads/${flavor}/ad.m3u8`;
// One clock for the program date, so START-DATE maps to presentation time.
const epoch = Date.UTC(2026, 0, 1);
const date = (seconds) => new Date(epoch + seconds * 1000).toISOString();

/** A media playlist of the flavor with its URIs pointing back to it and a program date. */
function media(name, extra) {
  const source = readFileSync(join(out, flavor, name), 'utf8');
  return source
    .replace(/^(#EXT-X-MAP:URI=")([^"]+)"/m, `$1../${flavor}/$2"`)
    .replace(/^([a-z][^#\n]*\.m4s)$/gm, `../${flavor}/$1`)
    .replace(/(#EXT-X-PLAYLIST-TYPE:VOD\n)/, `$1#EXT-X-PROGRAM-DATE-TIME:${date(0)}\n${extra}`);
}

const codecs = readFileSync(join(out, flavor, 'master.m3u8'), 'utf8').match(
  /RESOLUTION=320x180,CODECS="([^"]+)"/,
)?.[1];
if (codecs === undefined) throw new Error(`no lowest rung in ${flavor}/master.m3u8`);

/** A master over one media playlist and the English audio. */
const master = (playlist) => `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=320x180,CODECS="${codecs}",AUDIO="aud"
${playlist}
`;

const range = (id, seconds, attributes) =>
  `#EXT-X-DATERANGE:ID="${id}",CLASS="com.apple.hls.interstitial",START-DATE="${date(seconds)}",${attributes}\n`;

writeFileSync(join(dir, 'audio.m3u8'), media('aud-lo-en.m3u8', ''));
writeFileSync(
  join(dir, 'video.m3u8'),
  media(
    'low.m3u8',
    range('pre', 0, `CUE="PRE",X-ASSET-URI="${ad}"`) +
      range('mid', 20, `X-ASSET-URI="${ad}",X-RESUME-OFFSET=0`) +
      range(
        'replace',
        40,
        `DURATION=8.0,X-ASSET-URI="${ad}",X-TIMELINE-OCCUPIES=RANGE,X-RESTRICT="SKIP,JUMP"`,
      ) +
      range('post', 0, `CUE="POST",X-ASSET-URI="${ad}"`),
  ),
);
writeFileSync(join(dir, 'master.m3u8'), master('video.m3u8'));

writeFileSync(
  join(dir, 'assets.json'),
  `${JSON.stringify(
    {
      ASSETS: [
        { URI: ad, DURATION: 8 },
        { URI: ad, DURATION: 8 },
      ],
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(dir, 'video-list.m3u8'),
  media('low.m3u8', range('list', 20, 'X-ASSET-LIST="assets.json",X-RESUME-OFFSET=0')),
);
writeFileSync(join(dir, 'master-list.m3u8'), master('video-list.m3u8'));

// A cue-out on the segment that starts at 24 s and a cue-in on the one at
// 32 s, with a splice_insert sample of SCTE 35 §14 as its OATCLS section.
let index = 0;
const cued = media('low.m3u8', '').replace(/^(#EXTINF:[^\n]*\n)/gm, (line) => {
  const at = index * 4;
  index += 1;
  if (at === 24)
    return `#EXT-OATCLS-SCTE35:/DAvAAAAAAAA///wFAVIAACPf+/+c2nALv4AUsz1AAAAAAAKAAhDVUVJAAABNWLbowo=\n#EXT-X-CUE-OUT:8\n${line}`;
  if (at === 32) return `#EXT-X-CUE-IN\n${line}`;
  return line;
});
writeFileSync(join(dir, 'video-cue.m3u8'), cued);
writeFileSync(join(dir, 'master-cue.m3u8'), master('video-cue.m3u8'));

// The same span as a date range (RFC 8216bis §4.4.5.1.1): SCTE35-OUT carries
// the time_signal placement opportunity sample of SCTE 35 §14 as a
// hexadecimal sequence, and a later tag with the same ID gives the end.
const section = Buffer.from(
  '/DA0AAAAAAAA///wBQb+cr0AUAAeAhxDVUVJSAAAjn/PAAGlmbAICAAAAAAsoKGKNAIAmsnRfg==',
  'base64',
).toString('hex');
writeFileSync(
  join(dir, 'video-scte35.m3u8'),
  media(
    'low.m3u8',
    `#EXT-X-DATERANGE:ID="splice-24",START-DATE="${date(24)}",PLANNED-DURATION=8.0,SCTE35-OUT=0x${section}\n` +
      `#EXT-X-DATERANGE:ID="splice-24",START-DATE="${date(24)}",END-DATE="${date(32)}"\n`,
  ),
);
writeFileSync(join(dir, 'master-scte35.m3u8'), master('video-scte35.m3u8'));

// DASH: the flavor's MPD with an insert at 20 s and a replace of 8 s at
// 40 s that may not be jumped, both pointing at the ad's MPD.
const dash = join(out, `${flavor}-dash`);
const mpd = readFileSync(join(dash, 'manifest.mpd'), 'utf8');
const events = `<EventStream schemeIdUri="urn:mpeg:dash:event:alternativeMPD:insert:2025" timescale="1">
			<Event presentationTime="20" id="insert-20"><InsertPresentation uri="../ads/${flavor}/ad.mpd" returnOffset="0"/></Event>
		</EventStream>
		<EventStream schemeIdUri="urn:mpeg:dash:event:alternativeMPD:replace:2025" timescale="1">
			<Event presentationTime="40" duration="8" id="replace-40"><ReplacePresentation uri="../ads/${flavor}/ad.mpd" noJump="1"/></Event>
		</EventStream>
		`;
writeFileSync(
  join(dash, 'manifest-interstitials.mpd'),
  mpd.replace(/(<Period[^>]*>\s*)/, `$1${events}`),
);
