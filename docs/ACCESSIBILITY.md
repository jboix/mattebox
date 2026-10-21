# Accessibility

The engine draws no controls. It gives the player you build on it the
tracks, the labels and the captions that player needs to be accessible.
Whether your page meets [WCAG 2.2](https://www.w3.org/TR/WCAG22/) depends
on that player. [`<mattebox-player>`](https://github.com/jboix/mattebox-player)
aims at level AA.

## What the engine does

- It maps the accessibility signals of each manifest to the same media characteristic tags: HLS `CHARACTERISTICS`, DASH `Accessibility` and `Role`.
- `isAudioDescription`, `isEnhancedSpeech`, `isSdh` and `isOriginal` answer the questions a track menu asks. See [Audio and text](guide/06-audio-and-text.md).
- WebVTT, TTML, CEA-608 and CEA-708 subtitles show as native text tracks, so the browser's caption menu and caption settings apply to them.
- A pick in the browser's caption menu selects that track in the engine.
- Forced subtitles show while no other subtitle is selected.

## How it is checked

- Node tests cover the mapping of each signal, for HLS and for DASH.
- Browser tests check that each text format reaches a native text track, in Chromium, Firefox and WebKit.
- Biome's accessibility lint rules run on the code.

## Known limitations

- Image subtitles (the IMSC1 Image Profile) are pictures. A screen reader cannot read them, and the browser's caption settings do not change them. Offer a text track when the content has one.
- A stream without accessibility signals gives the engine nothing to map. The engine does not guess that a track is an audio description from its name.

## Report a barrier

[Open an accessibility issue](https://github.com/jboix/mattebox/issues/new?template=03_accessibility.yml)
and say what stopped you, with which stream, browser or device, and
assistive technology. Every report is read. There is no fixed timeline for
a fix.
