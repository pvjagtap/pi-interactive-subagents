/**
 * Minimal VT screen renderer for the Warp backend.
 *
 * psmux and WezTerm expose `capture-pane` / `get-text`, which return the
 * *rendered grid*. Warp exposes nothing, so we keep a raw pty transcript — but
 * a transcript is not a screen: a TUI paints by moving the cursor, so the text
 * arrives with thousands of CUP sequences and almost no newlines (measured:
 * 268 newlines and 6112 cursor-position escapes in 1.3 MB). Slicing "the last N
 * lines" of that is meaningless.
 *
 * This module replays the transcript through a small terminal emulator and
 * returns what a user would actually see. It deliberately implements only what
 * TUIs emit in practice; anything unknown is skipped rather than printed.
 */

export interface RenderOptions {
  rows?: number;
  cols?: number;
  /** Include scrollback above the viewport (default true). */
  scrollback?: boolean;
  /** Cap on retained scrollback rows. */
  maxScrollback?: number;
}

const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 80;

/**
 * Display width of a code point. Terminals render CJK/emoji as two cells; a
 * naive one-cell-per-unit model puts every later column in the wrong place.
 * Ranges follow the usual wcwidth "wide/fullwidth" blocks — enough for the CJK
 * and emoji a TUI actually emits, without embedding a full Unicode table.
 */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana .. CJK compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B+
  ) {
    return 2;
  }
  return 1;
}

class Grid {
  rows: number;
  cols: number;
  buf: string[][];
  scroll: string[][] = [];
  x = 0;
  y = 0;
  maxScrollback: number;

  constructor(rows: number, cols: number, maxScrollback: number) {
    this.rows = rows;
    this.cols = cols;
    this.maxScrollback = maxScrollback;
    this.buf = Grid.blank(rows, cols);
  }

  static blank(rows: number, cols: number): string[][] {
    return Array.from({ length: rows }, () => Array(cols).fill(" "));
  }

  clampCursor(): void {
    if (this.x < 0) this.x = 0;
    if (this.y < 0) this.y = 0;
    if (this.x >= this.cols) this.x = this.cols - 1;
    if (this.y >= this.rows) this.y = this.rows - 1;
  }

  newline(): void {
    this.y++;
    if (this.y >= this.rows) {
      const evicted = this.buf.shift()!;
      this.scroll.push(evicted);
      if (this.scroll.length > this.maxScrollback) {
        this.scroll.splice(0, this.scroll.length - this.maxScrollback);
      }
      this.buf.push(Array(this.cols).fill(" "));
      this.y = this.rows - 1;
    }
  }

  write(ch: string, width = 1): void {
    // A double-width glyph never straddles the right margin: terminals wrap it
    // whole. Writing per UTF-16 unit here used to split surrogate pairs across
    // rows, which corrupted the character entirely.
    if (this.x + width > this.cols) {
      this.x = 0;
      this.newline();
    }
    this.buf[this.y][this.x] = ch;
    for (let k = 1; k < width; k++) {
      if (this.x + k < this.cols) this.buf[this.y][this.x + k] = "";
    }
    this.x += width;
  }
}

/** Replay `raw` and return the visible text. */
export function renderScreen(raw: string, options: RenderOptions = {}): string {
  const rows = Math.max(1, options.rows ?? DEFAULT_ROWS);
  const cols = Math.max(1, options.cols ?? DEFAULT_COLS);
  const maxScrollback = options.maxScrollback ?? 5000;

  const main = new Grid(rows, cols, maxScrollback);
  const alt = new Grid(rows, cols, 0);
  let g = main;
  let saved = { x: 0, y: 0 };

  let i = 0;
  const n = raw.length;

  while (i < n) {
    const ch = raw[i];

    // ── C0 controls ────────────────────────────────────────────────────────
    if (ch === "\n") {
      // Treat LF as CR+LF. A pty with ONLCR already emits "\r\n", but plain
      // text appended to the log (e.g. the done sentinel) uses a bare "\n";
      // without the implied CR those lines render staircased.
      g.x = 0;
      g.newline();
      i++;
      continue;
    }
    if (ch === "\r") {
      g.x = 0;
      i++;
      continue;
    }
    if (ch === "\b") {
      g.x = Math.max(0, g.x - 1);
      i++;
      continue;
    }
    if (ch === "\t") {
      g.x = Math.min(g.cols - 1, (Math.floor(g.x / 8) + 1) * 8);
      i++;
      continue;
    }
    if (ch === "\u0007") {
      i++;
      continue;
    }
    if (ch !== "\u001b") {
      if (ch >= " " || ch === "\u00a0") {
        // Step by code point, not UTF-16 unit, so astral characters (emoji,
        // CJK ext) stay intact and occupy the right number of cells.
        const cp = raw.codePointAt(i)!;
        const text = String.fromCodePoint(cp);
        g.write(text, charWidth(cp));
        i += text.length;
        continue;
      }
      i++;
      continue;
    }

    // ── ESC sequences ──────────────────────────────────────────────────────
    const next = raw[i + 1];

    // OSC: ESC ] ... (BEL | ESC \)
    if (next === "]") {
      let j = i + 2;
      while (j < n && raw[j] !== "\u0007" && !(raw[j] === "\u001b" && raw[j + 1] === "\\")) j++;
      i = raw[j] === "\u0007" ? j + 1 : j + 2;
      continue;
    }

    // DCS/PM/APC: ESC P|^|_ ... ESC \
    if (next === "P" || next === "^" || next === "_") {
      let j = i + 2;
      while (j < n && !(raw[j] === "\u001b" && raw[j + 1] === "\\")) j++;
      i = j + 2;
      continue;
    }

    // CSI: ESC [ params intermediate final
    if (next === "[") {
      let j = i + 2;
      let params = "";
      let priv = "";
      if (raw[j] === "?" || raw[j] === ">" || raw[j] === "!") {
        priv = raw[j];
        j++;
      }
      while (j < n && /[0-9;]/.test(raw[j])) {
        params += raw[j];
        j++;
      }
      // Intermediate bytes (0x20-0x2F) sit between the parameters and the final
      // byte — e.g. DECSCUSR "ESC [ 6 SP q", which vim and many prompts emit.
      // Without consuming them the space was mistaken for the final byte and
      // the real final ('q') leaked into the visible text.
      while (j < n && raw[j] >= "\u0020" && raw[j] <= "\u002f") {
        j++;
      }
      const final = raw[j];
      i = j + 1;
      if (final === undefined) break;

      const nums = params.split(";").map((p) => (p === "" ? NaN : parseInt(p, 10)));
      const p0 = Number.isNaN(nums[0]) ? undefined : nums[0];
      const p1 = Number.isNaN(nums[1]) ? undefined : nums[1];

      switch (final) {
        case "H":
        case "f":
          g.y = (p0 ?? 1) - 1;
          g.x = (p1 ?? 1) - 1;
          g.clampCursor();
          break;
        case "A":
          g.y -= p0 ?? 1;
          g.clampCursor();
          break;
        case "B":
          g.y += p0 ?? 1;
          g.clampCursor();
          break;
        case "C":
          g.x += p0 ?? 1;
          g.clampCursor();
          break;
        case "D":
          g.x -= p0 ?? 1;
          g.clampCursor();
          break;
        case "E":
          g.x = 0;
          g.y += p0 ?? 1;
          g.clampCursor();
          break;
        case "F":
          g.x = 0;
          g.y -= p0 ?? 1;
          g.clampCursor();
          break;
        case "G":
          g.x = (p0 ?? 1) - 1;
          g.clampCursor();
          break;
        case "d":
          g.y = (p0 ?? 1) - 1;
          g.clampCursor();
          break;
        case "J": {
          const mode = p0 ?? 0;
          if (mode === 2 || mode === 3) {
            for (let r = 0; r < g.rows; r++) g.buf[r] = Array(g.cols).fill(" ");
          } else if (mode === 0) {
            for (let c = g.x; c < g.cols; c++) g.buf[g.y][c] = " ";
            for (let r = g.y + 1; r < g.rows; r++) g.buf[r] = Array(g.cols).fill(" ");
          } else {
            for (let c = 0; c <= g.x; c++) g.buf[g.y][c] = " ";
            for (let r = 0; r < g.y; r++) g.buf[r] = Array(g.cols).fill(" ");
          }
          break;
        }
        case "K": {
          const mode = p0 ?? 0;
          if (mode === 0) for (let c = g.x; c < g.cols; c++) g.buf[g.y][c] = " ";
          else if (mode === 1) for (let c = 0; c <= g.x; c++) g.buf[g.y][c] = " ";
          else g.buf[g.y] = Array(g.cols).fill(" ");
          break;
        }
        case "L": {
          const count = p0 ?? 1;
          for (let k = 0; k < count; k++) {
            g.buf.splice(g.y, 0, Array(g.cols).fill(" "));
            g.buf.splice(g.rows, 1);
          }
          break;
        }
        case "M": {
          const count = p0 ?? 1;
          for (let k = 0; k < count; k++) {
            g.buf.splice(g.y, 1);
            g.buf.splice(g.rows - 1, 0, Array(g.cols).fill(" "));
          }
          break;
        }
        case "X": {
          const count = p0 ?? 1;
          for (let c = g.x; c < Math.min(g.cols, g.x + count); c++) g.buf[g.y][c] = " ";
          break;
        }
        case "s":
          saved = { x: g.x, y: g.y };
          break;
        case "u":
          g.x = saved.x;
          g.y = saved.y;
          g.clampCursor();
          break;
        case "h":
        case "l":
          // Alt-screen switch (1047/1049/47): most TUIs, pi included, render there.
          if (priv === "?" && (p0 === 1049 || p0 === 1047 || p0 === 47)) {
            if (final === "h") {
              for (let r = 0; r < alt.rows; r++) alt.buf[r] = Array(alt.cols).fill(" ");
              alt.x = 0;
              alt.y = 0;
              g = alt;
            } else {
              g = main;
            }
          }
          break;
        default:
          // SGR (m), DSR (n), scroll regions (r) etc. do not affect our text grid.
          break;
      }
      continue;
    }

    // ESC 7 / ESC 8 save+restore, ESC M reverse index, ESC ( charset …
    if (next === "7") {
      saved = { x: g.x, y: g.y };
      i += 2;
      continue;
    }
    if (next === "8") {
      g.x = saved.x;
      g.y = saved.y;
      g.clampCursor();
      i += 2;
      continue;
    }
    if (next === "M") {
      g.y = Math.max(0, g.y - 1);
      i += 2;
      continue;
    }
    if (next === "(" || next === ")" || next === "#") {
      i += 3;
      continue;
    }
    i += 2;
  }

  const useScroll = options.scrollback !== false && g === main;
  const all = useScroll ? [...g.scroll, ...g.buf] : g.buf;
  // "" marks the continuation cell of a double-width glyph; drop it on join.
  return all.map((r) => r.join("").replace(/\s+$/, "")).join("\n");
}

/** Render, then return the last `lines` non-trailing-blank rows. */
export function renderTail(raw: string, lines: number, options: RenderOptions = {}): string {
  const rendered = renderScreen(raw, options).split("\n");
  while (rendered.length && rendered[rendered.length - 1].trim() === "") rendered.pop();
  return rendered.slice(-Math.max(1, lines)).join("\n");
}
