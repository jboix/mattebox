/**
 * Shows IMSC1 image subtitles in a container the page places over the
 * video. A VTTCue holds text only, so the browser cannot draw an image cue;
 * this draws the active image cues of the showing text track instead, as
 * dash.js draws TTML into the div a page attaches. It adds no member to
 * the element: the page owns the container and where it sits.
 */

interface ImagePayload {
  readonly image: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function imageOf(cue: TextTrackCue): ImagePayload | null {
  const payload = (cue as TextTrackCue & { payload?: Partial<ImagePayload> }).payload;
  return typeof payload?.image === 'string' ? (payload as ImagePayload) : null;
}

/** Draws the image cues into `container` until the returned function stops it. */
export function showImages(element: HTMLMediaElement, container: HTMLElement): () => void {
  const tracks = element.textTracks;
  const drawn: HTMLImageElement[] = [];
  const watched = new Set<TextTrack>();

  function render(): void {
    for (const img of drawn.splice(0)) img.remove();
    for (let i = 0; i < tracks.length; i += 1) {
      const track = tracks[i] as TextTrack;
      if (track.mode !== 'showing') continue;
      const active = track.activeCues;
      for (let j = 0; active !== null && j < active.length; j += 1) {
        const box = imageOf(active[j] as TextTrackCue);
        if (box === null) continue;
        const img = document.createElement('img');
        img.src = box.image;
        img.alt = '';
        const style = img.style;
        style.position = 'absolute';
        style.left = `${box.left}%`;
        style.top = `${box.top}%`;
        style.width = `${box.width}%`;
        style.height = `${box.height}%`;
        style.objectFit = 'contain';
        style.pointerEvents = 'none';
        container.appendChild(img);
        drawn.push(img);
      }
    }
  }

  function watch(): void {
    for (let i = 0; i < tracks.length; i += 1) {
      const track = tracks[i] as TextTrack;
      if (watched.has(track)) continue;
      watched.add(track);
      track.addEventListener('cuechange', render);
    }
  }

  const onTracks = (): void => {
    watch();
    render();
  };
  tracks.addEventListener('addtrack', onTracks);
  tracks.addEventListener('change', onTracks);
  onTracks();

  return () => {
    tracks.removeEventListener('addtrack', onTracks);
    tracks.removeEventListener('change', onTracks);
    for (const track of watched) track.removeEventListener('cuechange', render);
    watched.clear();
    for (const img of drawn.splice(0)) img.remove();
  };
}
