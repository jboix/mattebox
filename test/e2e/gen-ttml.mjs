// Writes subtitles in three formats beside a DASH flavor of the E2E corpus:
// a TTML sidecar file, an stpp track (TTML in fMP4), and a wvtt track
// (WebVTT in fMP4, both ISO/IEC 14496-30), and an MPD that declares them
// next to the flavor's video.
//
// - subs.ttml: "sidecar n" from 4n + 1 s to 4n + 3 s, English.
// - stpp-init.mp4 and stpp-N.m4s: one 4 s segment per video segment, each
//   one sample whose document says "stpp N" from 0.5 s to 3.5 s into the
//   segment, in media time (the sample's decode time plus the offset), German.
// - wvtt-init.mp4 and wvtt-N.m4s: one 4 s segment per video segment, two
//   2 s samples: "wvtt N" in a vttc box, then an empty vtte span, French.
//
// Usage: node gen-ttml.mjs <dash dir>
//   reads  <dir>/manifest.mpd
//   writes <dir>/manifest-ttml.mpd, subs.ttml, stpp-init.mp4, stpp-N.m4s,
//          wvtt-init.mp4, wvtt-N.m4s
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir] = process.argv.slice(2);
if (dir === undefined) {
  console.error('usage: node gen-ttml.mjs <dash dir>');
  process.exit(1);
}

const SEGMENT = 4;
const mpd = readFileSync(join(dir, 'manifest.mpd'), 'utf8');
const total = Number(
  /mediaPresentationDuration="PT(?:(\d+)M)?([\d.]+)S"/
    .exec(mpd)
    ?.slice(1)
    .reduce((s, v, i) => s + (i === 0 ? Number(v ?? 0) * 60 : Number(v)), 0),
);
const count = Math.ceil(total / SEGMENT);

const clock = (seconds) => {
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = (seconds % 60).toFixed(3).padStart(6, '0');
  return `${h}:${m}:${s}`;
};

const doc = (paragraphs, lang) => `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xml:lang="${lang}">
  <head><layout><region xml:id="bottom" tts:origin="10% 80%" tts:extent="80% 15%" tts:displayAlign="after" tts:textAlign="center"/></layout></head>
  <body region="bottom"><div>
${paragraphs.map(([from, to, text]) => `    <p begin="${clock(from)}" end="${clock(to)}">${text}</p>`).join('\n')}
  </div></body>
</tt>
`;

const sidecar = [];
for (let n = 0; n < count; n += 1) sidecar.push([n * SEGMENT + 1, n * SEGMENT + 3, `sidecar ${n}`]);
writeFileSync(join(dir, 'subs.ttml'), doc(sidecar, 'en'));

const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ascii = (text) => [...text].map((c) => c.charCodeAt(0));
const box = (type, body) => [...u32(8 + body.length), ...ascii(type), ...body];
const TIMESCALE = 1000;

// The init: one track with its timescale; the stpp sample entry names the
// IMSC namespace (ISO/IEC 14496-30 §5.2).
const stpp = box('stpp', [
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1, // reserved, data_reference_index
  ...ascii('http://www.w3.org/ns/ttml'),
  0,
  0, // schema_location
  0, // auxiliary_mime_types
]);
// wvtt sample entry with its WebVTT header (ISO/IEC 14496-30 §7.5).
const wvtt = box('wvtt', [0, 0, 0, 0, 0, 0, 0, 1, ...box('vttC', ascii('WEBVTT'))]);
const initWith = (entry) => [
  ...box('ftyp', [...ascii('iso6'), ...u32(0), ...ascii('iso6'), ...ascii('dash')]),
  ...box('moov', [
    ...box('mvhd', [
      0,
      0,
      0,
      0,
      ...u32(0),
      ...u32(0),
      ...u32(TIMESCALE),
      ...u32(0),
      ...new Array(80).fill(0),
      ...u32(2),
    ]),
    ...box('trak', [
      ...box('tkhd', [
        0,
        0,
        0,
        3,
        ...u32(0),
        ...u32(0),
        ...u32(1),
        ...u32(0),
        ...u32(0),
        ...new Array(60).fill(0),
      ]),
      ...box('mdia', [
        ...box('mdhd', [
          0,
          0,
          0,
          0,
          ...u32(0),
          ...u32(0),
          ...u32(TIMESCALE),
          ...u32(0),
          0x55,
          0xc4,
          0,
          0,
        ]),
        ...box('hdlr', [
          0,
          0,
          0,
          0,
          ...u32(0),
          ...ascii('subt'),
          ...u32(0),
          ...u32(0),
          ...u32(0),
          0,
        ]),
        ...box('minf', [
          ...box('sthd', [0, 0, 0, 0]),
          ...box('stbl', [
            ...box('stsd', [0, 0, 0, 0, ...u32(1), ...entry]),
            ...box('stts', [0, 0, 0, 0, ...u32(0)]),
            ...box('stsc', [0, 0, 0, 0, ...u32(0)]),
            ...box('stsz', [0, 0, 0, 0, ...u32(0), ...u32(0)]),
            ...box('stco', [0, 0, 0, 0, ...u32(0)]),
          ]),
        ]),
      ]),
    ]),
    ...box('mvex', [
      ...box('trex', [0, 0, 0, 0, ...u32(1), ...u32(1), ...u32(0), ...u32(0), ...u32(0)]),
    ]),
  ]),
];
writeFileSync(join(dir, 'stpp-init.mp4'), Uint8Array.from(initWith(stpp)));
writeFileSync(join(dir, 'wvtt-init.mp4'), Uint8Array.from(initWith(wvtt)));

for (let n = 1; n <= count; n += 1) {
  const start = (n - 1) * SEGMENT;
  const sample = [
    ...new TextEncoder().encode(doc([[start + 0.5, start + 3.5, `stpp ${n}`]], 'de')),
  ];
  const moof = (offset) =>
    box('moof', [
      ...box('mfhd', [0, 0, 0, 0, ...u32(n)]),
      ...box('traf', [
        ...box('tfhd', [0, 0x02, 0, 0, ...u32(1)]), // default-base-is-moof
        ...box('tfdt', [0, 0, 0, 0, ...u32(start * TIMESCALE)]),
        // data offset, duration, size
        ...box('trun', [
          0,
          0,
          0x03,
          0x01,
          ...u32(1),
          ...u32(offset),
          ...u32(SEGMENT * TIMESCALE),
          ...u32(sample.length),
        ]),
      ]),
    ]);
  const size = moof(0).length;
  writeFileSync(
    join(dir, `stpp-${n}.m4s`),
    Uint8Array.from([...moof(size + 8), ...box('mdat', sample)]),
  );

  // wvtt: a cue for the first half of the segment, nothing for the second.
  const half = (SEGMENT / 2) * TIMESCALE;
  const shown = box('vttc', [
    ...box('sttg', ascii('line:85%')),
    ...box('payl', ascii(`wvtt ${n}`)),
  ]);
  const empty = box('vtte', []);
  const wvttMoof = (offset) =>
    box('moof', [
      ...box('mfhd', [0, 0, 0, 0, ...u32(n)]),
      ...box('traf', [
        ...box('tfhd', [0, 0x02, 0, 0, ...u32(1)]),
        ...box('tfdt', [0, 0, 0, 0, ...u32(start * TIMESCALE)]),
        ...box('trun', [
          ...[0, 0, 0x03, 0x01, ...u32(2), ...u32(offset)],
          ...[...u32(half), ...u32(shown.length), ...u32(half), ...u32(empty.length)],
        ]),
      ]),
    ]);
  const wvttSize = wvttMoof(0).length;
  writeFileSync(
    join(dir, `wvtt-${n}.m4s`),
    Uint8Array.from([...wvttMoof(wvttSize + 8), ...box('mdat', [...shown, ...empty])]),
  );
}

const sets = `		<AdaptationSet id="10" contentType="text" mimeType="application/ttml+xml" lang="en">
			<Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/>
			<Representation id="ttml" bandwidth="1000"><BaseURL>subs.ttml</BaseURL></Representation>
		</AdaptationSet>
		<AdaptationSet id="11" contentType="text" mimeType="application/mp4" codecs="stpp.ttml.im1t" lang="de">
			<Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/>
			<Representation id="stpp" bandwidth="1000">
				<SegmentTemplate timescale="${TIMESCALE}" duration="${SEGMENT * TIMESCALE}" startNumber="1" initialization="stpp-init.mp4" media="stpp-$Number$.m4s"/>
			</Representation>
		</AdaptationSet>
		<AdaptationSet id="12" contentType="text" mimeType="application/mp4" codecs="wvtt" lang="fr">
			<Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/>
			<Representation id="wvtt" bandwidth="1000">
				<SegmentTemplate timescale="${TIMESCALE}" duration="${SEGMENT * TIMESCALE}" startNumber="1" initialization="wvtt-init.mp4" media="wvtt-$Number$.m4s"/>
			</Representation>
		</AdaptationSet>
	</Period>`;
writeFileSync(join(dir, 'manifest-ttml.mpd'), mpd.replace('\t</Period>', sets));

// IMSC1 Image Profile (W3C IMSC1 §6): subs-image.ttml with two PNG
// subtitles, Italian. The first, from 1 s to 3 s, is embedded as an
// smpte:image; the second, from 5 s to 7 s, is the file subs-image-1.png.
// Both fill the region at origin 10% 80%, extent 80% 15%.
const { deflateSync } = await import('node:zlib');
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => [
  ...u32(data.length),
  ...ascii(type),
  ...data,
  ...u32(crc32([...ascii(type), ...data])),
];
/** A solid RGB PNG, width by height. */
const png = (width, height, [r, g, b]) => {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(0);
    for (let x = 0; x < width; x += 1) rows.push(r, g, b);
  }
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', [...u32(width), ...u32(height), 8, 2, 0, 0, 0]),
    ...chunk('IDAT', [...deflateSync(Uint8Array.from(rows))]),
    ...chunk('IEND', []),
  ]);
};
const embedded = Buffer.from(png(32, 6, [255, 0, 0])).toString('base64');
writeFileSync(join(dir, 'subs-image-1.png'), png(32, 6, [0, 0, 255]));
writeFileSync(
  join(dir, 'subs-image.ttml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"
    xmlns:ttp="http://www.w3.org/ns/ttml#parameter"
    xmlns:smpte="http://www.smpte-ra.org/schemas/2052-1/2010/smpte"
    ttp:profile="http://www.w3.org/ns/ttml/profile/imsc1/image" xml:lang="it">
  <head>
    <metadata><smpte:image xml:id="img0" imagetype="PNG" encoding="Base64">${embedded}</smpte:image></metadata>
    <layout><region xml:id="r" tts:origin="10% 80%" tts:extent="80% 15%"/></layout>
  </head>
  <body>
    <div region="r" begin="00:00:01.000" end="00:00:03.000" smpte:backgroundImage="#img0"/>
    <div region="r" begin="00:00:05.000" end="00:00:07.000" smpte:backgroundImage="subs-image-1.png"/>
  </body>
</tt>
`,
);
const imageSet = `		<AdaptationSet id="13" contentType="text" mimeType="application/ttml+xml" lang="it">
			<Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/>
			<Representation id="ttml-image" bandwidth="1000"><BaseURL>subs-image.ttml</BaseURL></Representation>
		</AdaptationSet>
	</Period>`;
writeFileSync(join(dir, 'manifest-ttml-image.mpd'), mpd.replace('\t</Period>', imageSet));
