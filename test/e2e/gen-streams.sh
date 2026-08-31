#!/usr/bin/env bash
# Generates the CMAF VOD streams the E2E suite plays, HLS and DASH packaged
# from the same encodes: two variants per codec flavor, video only. h264 for
# firefox and webkit; vp9 because Playwright's chromium ships no H.264
# decoder. Output is gitignored and regenerated on demand. Needs ffmpeg,
# which the workflows install with apt.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/test/fixtures/streams"
DURATION=72

if [ -f "$OUT/h264/master.m3u8" ] && [ -f "$OUT/vp9/master.m3u8" ] &&
   [ -f "$OUT/h264-dash/manifest.mpd" ] && [ -f "$OUT/vp9-dash/manifest.mpd" ] &&
   [ -f "$OUT/ts/master.m3u8" ] && [ -f "$OUT/aac/master.m3u8" ]; then
  echo "streams present, skipping generation"
  exit 0
fi

command -v ffmpeg >/dev/null || { echo "ffmpeg is required to generate E2E streams"; exit 1; }
mkdir -p "$OUT"

# Encode one variant. The codec string comes from a throwaway DASH pass so
# the master playlist's CODECS never lies.
variant() { # flavor name size bitrate vcodec extra...
  local flavor=$1 name=$2 size=$3 bitrate=$4 vcodec=$5
  shift 5
  local dir="$OUT/$flavor"
  mkdir -p "$dir"
  local tmp
  tmp=$(mktemp -d)
  ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=$size:rate=30" -t 1 \
    -c:v "$vcodec" -pix_fmt yuv420p -b:v "$bitrate" "$@" \
    -f dash -dash_segment_type mp4 "$tmp/probe.mpd"
  local codec
  codec=$(grep -o 'codecs="[^"]*"' "$tmp/probe.mpd" | head -1 | sed 's/codecs="//;s/"//')
  rm -rf "$tmp"

  ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=$size:rate=30" -t $DURATION \
    -c:v "$vcodec" -pix_fmt yuv420p -b:v "$bitrate" -g 120 -keyint_min 120 "$@" \
    -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 \
    -hls_fmp4_init_filename "init-$name.mp4" \
    -hls_segment_filename "$dir/seg-$name-%03d.m4s" \
    "$dir/$name.m3u8"
  echo "$codec"
}

# A segmented WebVTT subtitle rendition: one 4 s segment per media segment,
# each with a per-segment X-TIMESTAMP-MAP and 0-based local cue times, so
# the offset arithmetic is actually exercised.
subs() { # flavor
  local dir="$OUT/$1"
  {
    echo "#EXTM3U"
    echo "#EXT-X-VERSION:7"
    echo "#EXT-X-TARGETDURATION:4"
    echo "#EXT-X-MEDIA-SEQUENCE:0"
    echo "#EXT-X-PLAYLIST-TYPE:VOD"
    for i in $(seq 0 17); do
      printf "#EXTINF:4.000000,\nseg-sub-%03d.vtt\n" "$i"
    done
    echo "#EXT-X-ENDLIST"
  } > "$dir/subs.m3u8"
  for i in $(seq 0 17); do
    printf "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:%d\n\n00:00:00.500 --> 00:00:03.500 align:center\ncue %d\n" \
      $((i * 360000)) "$i" > "$dir/$(printf 'seg-sub-%03d.vtt' "$i")"
  done
}

# One audio rendition. `freq` distinguishes the groups; `acodec` is the
# ffmpeg encoder. AAC for h264 (Firefox and WebKit decode both), Opus for
# vp9 (Chromium decodes both), so every browser can play some pairing.
audio() { # flavor name bitrate freq acodec
  local flavor=$1 name=$2 bitrate=$3 freq=$4 acodec=$5
  local dir="$OUT/$flavor"
  mkdir -p "$dir"
  ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=$freq:sample_rate=48000" -t $DURATION \
    -c:a "$acodec" -b:a "$bitrate" \
    -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 \
    -hls_fmp4_init_filename "init-$name.mp4" \
    -hls_segment_filename "$dir/seg-$name-%03d.m4s" \
    "$dir/$name.m3u8"
}

master() { # flavor lowCodec highCodec topCodec acodec astring
  local flavor=$1 low=$2 high=$3 top=$4 acodec=$5 astring=$6
  # Two audio groups: `aud-lo` couples to the lowest video rung, `aud-hi`
  # to the upper two, so a video rung switch drags the audio group with it.
  # Each group carries English and French for in-group language switching.
  audio "$flavor" aud-lo-en 64k 440 "$acodec"
  audio "$flavor" aud-lo-fr 64k 480 "$acodec"
  audio "$flavor" aud-hi-en 128k 660 "$acodec"
  audio "$flavor" aud-hi-fr 128k 720 "$acodec"
  cat > "$OUT/$flavor/master.m3u8" <<EOF
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",AUTOSELECT=YES,URI="subs.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-lo",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="aud-lo-en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-lo",NAME="French",LANGUAGE="fr",AUTOSELECT=YES,URI="aud-lo-fr.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-hi",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="aud-hi-en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-hi",NAME="French",LANGUAGE="fr",AUTOSELECT=YES,URI="aud-hi-fr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=320x180,CODECS="$low,$astring",AUDIO="aud-lo",SUBTITLES="subs"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=480x270,CODECS="$high,$astring",AUDIO="aud-hi",SUBTITLES="subs"
high.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,CODECS="$top,$astring",AUDIO="aud-hi",SUBTITLES="subs"
top.m3u8
EOF
  subs "$flavor"
}

# A single-variant muxed MPEG-TS HLS stream: H.264 video and AAC audio in the
# same .ts segments, the legacy shape MSE cannot accept without ts-transmux.
# H.264 only, so Firefox and WebKit decode it; Chromium ships no H.264 decoder.
ts_flavor() {
  local dir="$OUT/ts"
  mkdir -p "$dir"
  # The codec string comes from a throwaway fMP4 pass so the master playlist's
  # CODECS is the real Main-profile string, never a guess. A wrong profile in
  # CODECS is tolerated by Firefox but rejected by Chrome on append.
  local tmp
  tmp=$(mktemp -d)
  ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=320x180:rate=30" -t 1 \
    -c:v libx264 -profile:v main -bf 2 -pix_fmt yuv420p -b:v 300k \
    -f dash -dash_segment_type mp4 "$tmp/probe.mpd"
  local vcodec
  vcodec=$(grep -o 'codecs="[^"]*"' "$tmp/probe.mpd" | head -1 | sed 's/codecs="//;s/"//')
  rm -rf "$tmp"
  # Main profile with B-frames on purpose: access units then do not align to
  # PES packets and PTS differs from DTS, the shape real legacy TS ships and the
  # one that broke a naive one-PES-per-frame transmux.
  ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=320x180:rate=30" \
    -f lavfi -i "sine=frequency=440:sample_rate=44100" -t $DURATION \
    -c:v libx264 -profile:v main -bf 2 -pix_fmt yuv420p -b:v 300k -g 120 -keyint_min 120 \
    -c:a aac -b:a 96k \
    -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type mpegts \
    -hls_segment_filename "$dir/seg-%03d.ts" "$dir/media.m3u8"
  cat > "$dir/master.m3u8" <<EOF
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x180,CODECS="$vcodec,mp4a.40.2"
media.m3u8
EOF
}

# An audio-only packed-AAC HLS stream: bare ADTS segments, no container, the
# Apple bipbop gear0 shape that packed-audio wraps into fMP4.
aac_flavor() {
  local dir="$OUT/aac"
  mkdir -p "$dir"
  ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=440:sample_rate=44100" -t $DURATION \
    -c:a aac -b:a 96k \
    -f segment -segment_time 4 -segment_format adts -segment_list "$dir/media.m3u8" \
    -segment_list_type m3u8 "$dir/seg-%03d.aac"
  cat > "$dir/master.m3u8" <<EOF
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="mp4a.40.2"
media.m3u8
EOF
}

# The same content DASH-packaged: three representations in one adaptation
# set, SegmentTimeline plus the $Number%05d$ template ffmpeg emits.
dash() { # flavor vcodec extra...
  local flavor=$1 vcodec=$2
  shift 2
  local dir="$OUT/$flavor-dash"
  mkdir -p "$dir"
  ffmpeg -y -loglevel error \
    -f lavfi -i "testsrc2=size=320x180:rate=30" \
    -f lavfi -i "testsrc2=size=480x270:rate=30" \
    -f lavfi -i "testsrc2=size=640x360:rate=30" -t $DURATION \
    -map 0:v -map 1:v -map 2:v -c:v "$vcodec" -pix_fmt yuv420p \
    -b:v:0 150k -b:v:1 300k -b:v:2 600k -g 120 -keyint_min 120 "$@" \
    -f dash -dash_segment_type mp4 -seg_duration 4 -use_template 1 -use_timeline 1 \
    -adaptation_sets "id=0,streams=v" \
    "$dir/manifest.mpd"
}

H_LOW=$(variant h264 low 320x180 150k libx264 -profile:v baseline)
H_HIGH=$(variant h264 high 480x270 300k libx264 -profile:v baseline)
H_TOP=$(variant h264 top 640x360 600k libx264 -profile:v baseline)
master h264 "$H_LOW" "$H_HIGH" "$H_TOP" aac mp4a.40.2
dash h264 libx264 -profile:v baseline

V_LOW=$(variant vp9 low 320x180 150k libvpx-vp9 -deadline realtime -cpu-used 8)
V_HIGH=$(variant vp9 high 480x270 300k libvpx-vp9 -deadline realtime -cpu-used 8)
V_TOP=$(variant vp9 top 640x360 600k libvpx-vp9 -deadline realtime -cpu-used 8)
master vp9 "$V_LOW" "$V_HIGH" "$V_TOP" libopus opus
dash vp9 libvpx-vp9 -deadline realtime -cpu-used 8

ts_flavor
aac_flavor

echo "generated: h264 [$H_LOW] vp9 [$V_LOW] plus dash flavors, three rungs"
