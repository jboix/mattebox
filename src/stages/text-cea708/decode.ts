/**
 * A CEA-708 caption decoder (CTA-708-E): DTVCC packets to cue text per
 * window. The packet layer joins the cc_data pairs of cc_type 3 (packet
 * start) and 2 (packet data); the service layer splits a packet into service
 * blocks; each service keeps its eight windows, its current window and pen,
 * and applies the C0, C1, G0, G1, G2, and G3 code sets. C2 and C3 carry no
 * defined commands and are skipped by their length.
 *
 * Like the 608 decoder, it emits a cue only when a visible window's text or
 * layout changes, never per character. A cue is complete once it closes, so
 * `drain` returns closed cues.
 */

/** Where and how a window sits on screen: what a cue placement needs (§8.4). */
export interface WindowLayout {
  readonly priority: number;
  /** True when the anchor is in percent (0 to 99 across, 0 to 74 down is absolute). */
  readonly relative: boolean;
  readonly anchorVertical: number;
  readonly anchorHorizontal: number;
  /** 0 top left, 1 top center, 2 top right, and so on to 8 bottom right. */
  readonly anchorPoint: number;
  readonly rows: number;
  readonly columns: number;
  /** 0 left, 1 right, 2 center, 3 full. */
  readonly justify: number;
}

export interface Cue708 {
  readonly start: number;
  end: number;
  /** WebVTT cue text: escaped, with `<i>` and `<u>` for the pen's italics and underline. */
  readonly text: string;
  readonly window: number;
  readonly layout: WindowLayout;
}

interface Cell {
  readonly char: string;
  readonly italic: boolean;
  readonly underline: boolean;
}

interface Window {
  layout: WindowLayout;
  visible: boolean;
  rows: Array<Array<Cell | undefined>>;
  row: number;
  column: number;
  italic: boolean;
  underline: boolean;
}

/** The widest row a 16:9 service may write (§8.4.10). */
const MAX_COLUMNS = 42;

/** G2 characters (§7.1.8); others are not defined and are skipped. */
const G2: Record<number, string> = {
  32: ' ',
  33: ' ',
  37: '…',
  42: 'Š',
  44: 'Œ',
  48: '█',
  49: '‘',
  50: '’',
  51: '“',
  52: '”',
  53: '•',
  57: '™',
  58: 'š',
  60: 'œ',
  61: '℠',
  63: 'Ÿ',
  118: '⅛',
  119: '⅜',
  120: '⅝',
  121: '⅞',
  122: '│',
  123: '┐',
  124: '└',
  125: '─',
  126: '┘',
  127: '┌',
};

/** The predefined window styles that center their text (§8.4.11, styles 3 and 6). */
const CENTERED_STYLES = new Set([3, 6]);

function escapeChar(char: string): string {
  return char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char;
}

/** One row as cue text, with tags where the pen's italics or underline change. */
function rowText(row: ReadonlyArray<Cell | undefined>): string {
  let out = '';
  let italic = false;
  let underline = false;
  let end = row.length;
  while (end > 0 && (row[end - 1] === undefined || row[end - 1]?.char === ' ')) end -= 1;
  for (let i = 0; i < end; i += 1) {
    const cell = row[i] ?? { char: ' ', italic: false, underline: false };
    if (underline && !cell.underline) out += '</u>';
    if (italic && !cell.italic) out += '</i>';
    if (cell.italic && !italic) out += '<i>';
    if (cell.underline && !underline) out += '<u>';
    italic = cell.italic;
    underline = cell.underline;
    out += escapeChar(cell.char);
  }
  if (underline) out += '</u>';
  if (italic) out += '</i>';
  return out;
}

function windowText(window: Window): string {
  const lines = window.rows.map(rowText);
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** One caption service: its windows, the current window, and its cues. */
export class Cea708Service {
  private windows: Array<Window | null> = new Array(8).fill(null);
  private current = -1;
  private delayUntil = 0;
  private readonly open = new Map<
    number,
    { key: string; text: string; start: number; layout: WindowLayout }
  >();
  private cues: Cue708[] = [];

  /** Decodes one service block received at `time`, in seconds. */
  decode(block: Uint8Array, time: number): void {
    // DLY holds the commands after it until its time or a DLC (§8.10.5.5):
    // their effect is stamped at the delay's end.
    if (time >= this.delayUntil) this.delayUntil = 0;
    let i = 0;
    while (i < block.length) {
      const code = block[i] as number;
      const at = Math.max(time, this.delayUntil);
      if (code === 0x10) i = this.extended(block, i + 1);
      else if (code < 0x20) i += this.c0(code, at);
      else if (code < 0x80) {
        this.write(code === 0x7f ? '♪' : String.fromCharCode(code));
        i += 1;
      } else if (code < 0xa0) i += this.c1(code, block, i, time);
      else {
        this.write(String.fromCharCode(code));
        i += 1;
      }
    }
    this.update(Math.max(time, this.delayUntil));
  }

  /** Closes the open cues at `time` and returns every closed cue. */
  flush(time: number): Cue708[] {
    for (const id of [...this.open.keys()]) this.close(id, time);
    return this.drain();
  }

  /** Returns the cues closed since the last drain and forgets them. */
  drain(): Cue708[] {
    const out = this.cues;
    this.cues = [];
    return out;
  }

  /** C0 (§7.1.4): the length of the code, after applying it. */
  private c0(code: number, time: number): number {
    const window = this.windows[this.current] ?? null;
    if (window !== null) {
      if (code === 0x08 && window.column > 0) {
        window.column -= 1;
        (window.rows[window.row] as Array<Cell | undefined>)[window.column] = undefined;
      } else if (code === 0x0c) {
        window.rows = window.rows.map(() => []);
        window.row = 0;
        window.column = 0;
      } else if (code === 0x0d) {
        this.carriageReturn(window);
      } else if (code === 0x0e) {
        window.rows[window.row] = [];
        window.column = 0;
      }
    }
    if (code === 0x03) this.update(time);
    // 0x00 to 0x0F take one byte, 0x10 to 0x17 two, 0x18 to 0x1F (P16) three.
    return code < 0x10 ? 1 : code < 0x18 ? 2 : 3;
  }

  /** A code after EXT1 (§7.1.7): C2, G2, C3, or G3. Returns the next offset. */
  private extended(block: Uint8Array, i: number): number {
    const code = block[i];
    if (code === undefined) return i;
    if (code < 0x20) return i + 1 + (code < 0x08 ? 0 : code < 0x10 ? 1 : code < 0x18 ? 2 : 3);
    if (code < 0x80) {
      const char = G2[code];
      if (char !== undefined) this.write(char);
      return i + 1;
    }
    if (code < 0xa0) {
      if (code < 0x88) return i + 5;
      if (code < 0x90) return i + 6;
      // Variable length: the next byte's low six bits count the bytes after it.
      return i + 2 + ((block[i + 1] ?? 0) & 0x3f);
    }
    // G3 defines only the closed caption icon.
    this.write(code === 0xa0 ? '[CC]' : '_');
    return i + 1;
  }

  /** C1 (§7.1.5): window and pen commands. Returns the length of the command. */
  private c1(code: number, block: Uint8Array, i: number, time: number): number {
    const arg = (n: number) => block[i + n] ?? 0;
    if (code <= 0x87) {
      if (this.windows[code - 0x80] !== null) this.current = code - 0x80;
      return 1;
    }
    if (code <= 0x8c) {
      const bits = arg(1);
      for (let id = 0; id < 8; id += 1) {
        const window = this.windows[id];
        if ((bits & (1 << id)) === 0 || window === null || window === undefined) continue;
        if (code === 0x88) window.rows = window.rows.map(() => []);
        else if (code === 0x89) window.visible = true;
        else if (code === 0x8a) window.visible = false;
        else if (code === 0x8b) window.visible = !window.visible;
        else {
          this.windows[id] = null;
          if (this.current === id) this.current = -1;
        }
      }
      return 2;
    }
    if (code === 0x8d) {
      this.delayUntil = time + arg(1) / 10;
      return 2;
    }
    if (code === 0x8e) {
      this.delayUntil = 0;
      return 1;
    }
    if (code === 0x8f) {
      this.windows = new Array(8).fill(null);
      this.current = -1;
      this.delayUntil = 0;
      return 1;
    }
    const window = this.windows[this.current] ?? null;
    if (code === 0x90) {
      // SPA: italics and underline are the top bits of its second byte.
      if (window !== null) {
        window.italic = (arg(2) & 0x80) !== 0;
        window.underline = (arg(2) & 0x40) !== 0;
      }
      return 3;
    }
    if (code === 0x91) return 4;
    if (code === 0x92) {
      if (window !== null) {
        window.row = Math.min(arg(1) & 0x0f, window.rows.length - 1);
        window.column = Math.min(arg(2) & 0x3f, MAX_COLUMNS - 1);
      }
      return 3;
    }
    if (code <= 0x96) return 1;
    if (code === 0x97) {
      if (window !== null) window.layout = { ...window.layout, justify: arg(3) & 0x03 };
      return 5;
    }
    this.define(code - 0x98, block.subarray(i + 1, i + 7));
    return 7;
  }

  /** DFn (§8.10.5.12): creates a window, or updates one and keeps its text. */
  private define(id: number, params: Uint8Array): void {
    const p = (n: number) => params[n] ?? 0;
    const known = this.windows[id] ?? null;
    const style = (p(5) >> 3) & 0x07;
    const rows = (p(3) & 0x0f) + 1;
    const layout: WindowLayout = {
      priority: p(0) & 0x07,
      relative: (p(1) & 0x80) !== 0,
      anchorVertical: p(1) & 0x7f,
      anchorHorizontal: p(2),
      anchorPoint: p(3) >> 4,
      rows,
      columns: (p(4) & 0x3f) + 1,
      // Style 0 keeps an existing window's style and gives a new one style 1.
      justify:
        style === 0 && known !== null ? known.layout.justify : CENTERED_STYLES.has(style) ? 2 : 0,
    };
    const visible = (p(0) & 0x20) !== 0;
    if (known === null) {
      this.windows[id] = {
        layout,
        visible,
        rows: Array.from({ length: rows }, () => []),
        row: 0,
        column: 0,
        italic: false,
        underline: false,
      };
    } else {
      known.layout = layout;
      known.visible = visible;
      // Fewer rows drop the top ones, as a roll-up does.
      while (known.rows.length > rows) known.rows.shift();
      while (known.rows.length < rows) known.rows.push([]);
      known.row = Math.min(known.row, rows - 1);
    }
    this.current = id;
  }

  private write(char: string): void {
    const window = this.windows[this.current] ?? null;
    if (window === null || window.column >= MAX_COLUMNS) return;
    const row = window.rows[window.row] as Array<Cell | undefined>;
    row[window.column] = { char, italic: window.italic, underline: window.underline };
    window.column += 1;
  }

  /** CR: the next row, scrolling the window up from its last one. */
  private carriageReturn(window: Window): void {
    window.column = 0;
    if (window.row + 1 < window.rows.length) {
      window.row += 1;
      return;
    }
    window.rows.shift();
    window.rows.push([]);
  }

  /** Closes and opens cues for every window whose shown text or layout changed. */
  private update(time: number): void {
    for (let id = 0; id < 8; id += 1) {
      const window = this.windows[id];
      const text = window?.visible === true ? windowText(window) : '';
      const key = text === '' ? '' : `${text}|${JSON.stringify(window?.layout)}`;
      if (key === (this.open.get(id)?.key ?? '')) continue;
      this.close(id, time);
      if (key !== '' && window !== null && window !== undefined) {
        this.open.set(id, { key, text, start: time, layout: window.layout });
      }
    }
  }

  private close(id: number, time: number): void {
    const open = this.open.get(id);
    if (open === undefined) return;
    this.open.delete(id);
    if (time > open.start) {
      this.cues.push({
        start: open.start,
        end: time,
        text: open.text,
        window: id,
        layout: open.layout,
      });
    }
  }
}

/**
 * The DTVCC transport (§5, §6): cc_type 3 starts a packet whose first byte
 * holds its sequence number and size, and cc_type 2 pairs continue it. A
 * packet cut short by the next start is dropped. Each complete packet's
 * service blocks go to their service.
 */
export class Dtvcc {
  private packet: number[] | null = null;
  private size = 0;
  private readonly services = new Map<number, Cea708Service>();

  push(type: number, a: number, b: number, time: number): void {
    if (type === 3) {
      const sizeCode = a & 0x3f;
      // The size counts the header byte in pairs; 0 means 128 bytes.
      this.size = (sizeCode === 0 ? 64 : sizeCode) * 2 - 1;
      this.packet = [b];
    } else if (type === 2 && this.packet !== null) {
      this.packet.push(a, b);
    } else {
      return;
    }
    if (this.packet.length >= this.size) {
      this.blocks(Uint8Array.from(this.packet.slice(0, this.size)), time);
      this.packet = null;
    }
  }

  /** Every service's closed cues since the last drain, by service number. */
  drain(): Map<number, Cue708[]> {
    const out = new Map<number, Cue708[]>();
    for (const [number, service] of this.services) {
      const cues = service.drain();
      if (cues.length > 0) out.set(number, cues);
    }
    return out;
  }

  /** Service blocks (§6.2): a header of service number and size, extended for services 7 to 63. */
  private blocks(data: Uint8Array, time: number): void {
    let i = 0;
    while (i < data.length) {
      const header = data[i] as number;
      let service = header >> 5;
      const size = header & 0x1f;
      i += 1;
      // A null block header ends the packet's service data.
      if (service === 0 || size === 0) return;
      if (service === 7) {
        service = (data[i] ?? 0) & 0x3f;
        i += 1;
      }
      let decoder = this.services.get(service);
      if (decoder === undefined) {
        decoder = new Cea708Service();
        this.services.set(service, decoder);
      }
      decoder.decode(data.subarray(i, i + size), time);
      i += size;
    }
  }
}
