# 19 Real devices

This chapter is the protocol for checking the engine on a TV and on iOS,
and the results of each run. The automated suites run in Playwright's
browsers on Linux; they say nothing about a TV's decoder or Safari on an
iPhone.

## The devices

| Device                            | Why                                        | Engine runtime |
| --------------------------------- | ------------------------------------------ | -------------- |
| Samsung TV, Tizen 6.0 (2021)      | The engine's API floor                     | Chromium 76    |
| LG TV, webOS 6 (2021)             | The other 2021 TV platform                 | Chromium 79    |
| iPhone or iPad, iOS 17.1 or later | ManagedMediaSource, the only MSE on iPhone | Safari         |

## The page

`test/devices/index.html` loads the ES2015 CDN bundle, the build a TV runs.
It lists public streams, the controls the checks need, and what the
platform decodes.

```sh
pnpm run build:cdn
python3 -m http.server 8080
```

Open `http://<your machine>:8080/test/devices/` on the device. The device
and your machine must share a network.

- Tizen: open the page in the TV's web browser, or package it as a hosted
  app with Tizen Studio and install it in developer mode. The app runtime
  is the one a production app uses, so record which one you ran.
- webOS: open the page in the TV's web browser, or create a hosted app
  with `ares-generate`, point it at the URL, and install it with
  `ares-install` in developer mode.
- iOS: open the page in Safari. Connect the device to a Mac and use Safari's
  Web Inspector to read the console.

## The checks

Run each check with each stream the platform decodes.

| Check           | Pass when                                                                 |
| --------------- | ------------------------------------------------------------------------- |
| Start           | Video plays within 5 seconds of the button                                |
| Steady playback | It plays 60 seconds, with no error and fewer than 10 dropped frames       |
| Seek            | After "Seek to 60 %", it plays again within 3 seconds                     |
| Quality         | "Lowest quality" shows the lowest height; "Automatic quality" climbs back |
| Audio           | "Next audio track" changes the audio, where the stream has two            |
| Live            | A live stream holds a steady latency for 60 seconds                       |
| Low latency     | LL-DASH and LL-HLS stay under 5 seconds of latency                        |
| Remote          | On a TV, the remote reaches every button and the video controls           |

Note the platform table too: it records the codecs and key systems the
device reports.

## Results

Add a row per run. "Not run" means nobody has run the protocol on that
device yet.

| Date | Device                    | Runtime | Engine version | Start | Steady | Seek | Quality | Audio | Live | Low latency | Notes |
| ---- | ------------------------- | ------- | -------------- | ----- | ------ | ---- | ------- | ----- | ---- | ----------- | ----- |
| -    | Samsung, Tizen 6.0        | not run | -              | -     | -      | -    | -       | -     | -    | -           | -     |
| -    | LG, webOS 6               | not run | -              | -     | -      | -    | -       | -     | -    | -           | -     |
| -    | iPhone, iOS 17.1 or later | not run | -              | -     | -      | -    | -       | -     | -    | -           | -     |
