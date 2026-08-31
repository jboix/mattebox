/**
 * A CEA-608 caption decoder: byte pairs to display changes to cue text. It
 * follows the parts of EIA-608 real captions actually use: the three modes
 * (pop-on, roll-up, paint-on), preamble address codes for row and indent,
 * mid-row style codes, the standard and special character sets, and the
 * memory controls that frame a caption's lifetime. Full 708 windows are out
 * of scope; the 608 pairs tunneled inside 708 are what this reads.
 *
 * The decoder is a pure function of the pairs it is fed. It emits a cue only
 * when the displayed screen changes, never per byte pair, so a paragraph of
 * roll-up captions is a handful of cues, not hundreds.
 */

export interface Cue {
  readonly start: number;
  end: number;
  text: string;
}

type Mode = 'popOn' | 'rollUp' | 'paintOn' | 'none';

const ROWS = 15;
const COLS = 32;

/** The basic CEA-608 character set: ASCII with a handful of substitutions. */
const BASIC: Record<number, string> = {
  42: 'á',
  92: 'é',
  94: 'í',
  95: 'ó',
  96: 'ú',
  123: 'ç',
  124: '÷',
  125: 'Ñ',
  126: 'ñ',
  127: '█',
};

/** Special characters, PAC-selected via 0x11/0x19 with 0x30-0x3f. */
const SPECIAL: Record<number, string> = {
  48: '®',
  49: '°',
  50: '½',
  51: '¿',
  52: '™',
  53: '¢',
  54: '£',
  55: '♪',
  56: 'à',
  57: ' ',
  58: 'è',
  59: 'â',
  60: 'ê',
  61: 'î',
  62: 'ô',
  63: 'û',
};

/** PAC row from the two control bytes; the standard's non-linear row map. */
const PAC_ROWS: readonly number[] = [11, 1, 3, 12, 14, 5, 7, 9];

function basicChar(code: number): string {
  if (code in BASIC) return BASIC[code] as string;
  if (code >= 0x20 && code < 0x80) return String.fromCharCode(code);
  return '';
}

export class Cea608Decoder {
  private mode: Mode = 'none';
  private displayed: string[] = blankScreen();
  private nonDisplayed: string[] = blankScreen();
  private row = ROWS - 1;
  private col = 0;
  private rollUpRows = 2;
  private lastControl = 0;
  private readonly cues: Cue[] = [];
  private openText: string | null = null;
  private openStart = 0;

  /** Feeds one CEA-608 byte pair at a presentation time in seconds. */
  push(a: number, b: number, time: number): void {
    const b0 = a & 0x7f;
    const b1 = b & 0x7f;
    // Control codes are the pairs whose first byte is 0x10-0x1f. They are
    // transmitted twice for reliability; a repeat is dropped.
    if (b0 >= 0x10 && b0 <= 0x1f) {
      const packed = (b0 << 8) | b1;
      if (packed === this.lastControl) {
        this.lastControl = 0;
        return;
      }
      this.lastControl = packed;
      this.control(b0, b1, time);
      return;
    }
    this.lastControl = 0;
    // Two printable characters (a null 0x00 pads an odd count).
    if (b0 !== 0) this.write(basicChar(b0));
    if (b1 !== 0) this.write(basicChar(b1));
    if (this.mode === 'paintOn' || this.mode === 'rollUp') this.refresh(time);
  }

  private control(b0: number, b1: number, time: number): void {
    // Mid-row style codes (0x11 0x20-0x2f) render as a space.
    if (b0 === 0x11 && b1 >= 0x20 && b1 <= 0x2f) {
      this.write(' ');
      return;
    }
    // Special characters (0x11/0x19 0x30-0x3f).
    if ((b0 === 0x11 || b0 === 0x19) && b1 >= 0x30 && b1 <= 0x3f) {
      this.write(SPECIAL[b1] ?? '');
      if (this.mode !== 'popOn') this.refresh(time);
      return;
    }
    // Preamble address codes: 0x10-0x17 (plus the 0x08 channel bit) with a
    // second byte 0x40-0x7f set the row and the horizontal indent.
    if (b0 >= 0x10 && b0 <= 0x17 && b1 >= 0x40 && b1 <= 0x7f) {
      this.pac(b0, b1);
      return;
    }
    // Miscellaneous control codes carry the mode and memory commands in the
    // low nibble of the second byte.
    if (b0 === 0x14 || b0 === 0x15 || b0 === 0x1c) {
      this.miscControl(b1, time);
    }
  }

  private miscControl(b1: number, time: number): void {
    switch (b1) {
      case 0x20: // RCL: resume caption loading -> pop-on
        this.mode = 'popOn';
        break;
      case 0x25: // RU2
      case 0x26: // RU3
      case 0x27: // RU4
        this.rollUpRows = b1 - 0x23;
        if (this.mode !== 'rollUp') {
          this.mode = 'rollUp';
          this.displayed = blankScreen();
        }
        this.row = ROWS - 1;
        this.col = 0;
        break;
      case 0x29: // RDC: resume direct captioning -> paint-on
        this.mode = 'paintOn';
        break;
      case 0x2c: // EDM: erase displayed memory
        this.closeCue(time);
        this.displayed = blankScreen();
        break;
      case 0x2d: // CR: carriage return (roll-up scroll)
        this.rollUp(time);
        break;
      case 0x2e: // ENM: erase non-displayed memory
        this.nonDisplayed = blankScreen();
        break;
      case 0x2f: // EOC: end of caption -> flip buffers (pop-on)
        this.closeCue(time);
        [this.displayed, this.nonDisplayed] = [this.nonDisplayed, this.displayed];
        this.refresh(time);
        break;
      default:
        break;
    }
  }

  private pac(b0: number, b1: number): void {
    const rowBase = PAC_ROWS[b0 & 0x07] ?? 1;
    const rowOffset = (b1 & 0x20) !== 0 ? 1 : 0;
    this.row = Math.min(ROWS - 1, rowBase - 1 + rowOffset);
    // Bit 0x10 distinguishes an indent PAC from a style PAC; indent is
    // (value & 0x0e) * 2 columns.
    this.col = (b1 & 0x10) !== 0 ? ((b1 & 0x0e) >> 1) * 4 : 0;
  }

  private target(): string[] {
    return this.mode === 'popOn' ? this.nonDisplayed : this.displayed;
  }

  private write(char: string): void {
    if (char === '') return;
    const screen = this.target();
    const line = screen[this.row] ?? '';
    const padded = line.padEnd(this.col, ' ');
    screen[this.row] = padded.slice(0, this.col) + char + padded.slice(this.col + 1);
    this.col = Math.min(COLS - 1, this.col + 1);
  }

  private rollUp(time: number): void {
    this.closeCue(time);
    // Scroll the base rows up by one and clear the bottom.
    const top = ROWS - this.rollUpRows;
    for (let r = top; r < ROWS - 1; r += 1) this.displayed[r] = this.displayed[r + 1] ?? '';
    this.displayed[ROWS - 1] = '';
    this.row = ROWS - 1;
    this.col = 0;
    this.refresh(time);
  }

  private refresh(time: number): void {
    const text = screenText(this.displayed);
    if (text === (this.openText ?? '')) return;
    this.closeCue(time);
    if (text !== '') {
      this.openText = text;
      this.openStart = time;
    }
  }

  private closeCue(time: number): void {
    if (this.openText === null) return;
    if (time > this.openStart) {
      this.cues.push({ start: this.openStart, end: time, text: this.openText });
    }
    this.openText = null;
  }

  /** Closes any open caption at the final time and returns every cue. */
  flush(time: number): Cue[] {
    this.closeCue(time);
    return this.cues;
  }

  /** Returns cues completed since the last drain and forgets them. */
  drain(): Cue[] {
    if (this.cues.length === 0) return [];
    return this.cues.splice(0, this.cues.length);
  }
}

function blankScreen(): string[] {
  return Array.from({ length: ROWS }, () => '');
}

function screenText(screen: readonly string[]): string {
  return screen
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '')
    .join('\n');
}
