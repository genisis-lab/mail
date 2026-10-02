/**
 * Streaming mbox reader (mboxo/mboxrd, as written by Google Takeout,
 * Thunderbird, Apple Mail and Wren's own export). Feed it file slices and it
 * hands back whole messages, with the "From " envelope line removed and
 * ">From " escapes undone. Works on bytes, so 8-bit mail is kept intact.
 */

const F = 0x46; // "F"
const LF = 0x0a;
const CR = 0x0d;
const GT = 0x3e; // ">"

/** Does `buf` hold "From " at `i`? */
function fromAt(buf: Uint8Array, i: number): boolean {
  return buf[i] === F && buf[i + 1] === 0x72 && buf[i + 2] === 0x6f && buf[i + 3] === 0x6d && buf[i + 4] === 0x20;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Strip the envelope line and the separating blank line, and undo ">From " quoting. */
function finish(segment: Uint8Array): Uint8Array {
  const start = segment.indexOf(LF) + 1;
  if (start <= 0) return new Uint8Array(0);
  let end = segment.length;
  // The blank line mbox puts before the next "From ".
  if (end - start >= 2 && segment[end - 1] === LF && segment[end - 2] === LF) end--;
  else if (end - start >= 4 && segment[end - 1] === LF && segment[end - 2] === CR && segment[end - 3] === LF && segment[end - 4] === CR) end -= 2;
  const out = new Uint8Array(end - start);
  let o = 0;
  let lineStart = true;
  for (let i = start; i < end; i++) {
    const b = segment[i];
    if (lineStart && b === GT) {
      // ">From ", ">>From ", …: drop one ">".
      let j = i;
      while (j < end && segment[j] === GT) j++;
      if (fromAt(segment, j)) {
        lineStart = false;
        continue; // this ">" goes
      }
    }
    out[o++] = b;
    lineStart = b === LF;
  }
  return out.subarray(0, o);
}

export class MboxSplitter {
  private buf: Uint8Array = new Uint8Array(0);
  /** Where the current (unfinished) message starts in `buf`. */
  private start = -1;
  /** How far `buf` has been searched for the next separator. */
  private scanned = 0;
  /** Bytes before the first "From " line (not an mbox file if this grows). */
  junk = 0;

  /** Add the next slice of the file; returns the messages it completed. */
  push(chunk: Uint8Array): Uint8Array[] {
    this.buf = concat(this.buf, chunk);
    return this.drain(false);
  }

  /** The file ended; returns the last message. */
  end(): Uint8Array[] {
    return this.drain(true);
  }

  private drain(final: boolean): Uint8Array[] {
    const out: Uint8Array[] = [];
    if (this.start < 0) {
      if (this.buf.length < 5 && !final) return out;
      if (fromAt(this.buf, 0)) {
        this.start = 0;
        this.scanned = 1;
      } else {
        // Skip to the first line that starts with "From ".
        let i = this.buf.indexOf(LF);
        while (i >= 0 && i + 6 <= this.buf.length && !fromAt(this.buf, i + 1)) i = this.buf.indexOf(LF, i + 1);
        if (i >= 0 && i + 6 <= this.buf.length) {
          this.junk += i + 1;
          this.buf = this.buf.subarray(i + 1);
          this.start = 0;
          this.scanned = 1;
        } else {
          const keep = Math.min(this.buf.length, 5);
          this.junk += this.buf.length - keep;
          this.buf = final ? new Uint8Array(0) : this.buf.slice(this.buf.length - keep);
          return out;
        }
      }
    }
    for (;;) {
      let i = this.buf.indexOf(LF, Math.max(this.scanned, this.start + 1) - 1);
      let next = -1;
      while (i >= 0) {
        if (i + 6 > this.buf.length) break; // can't tell yet
        if (fromAt(this.buf, i + 1)) {
          next = i + 1;
          break;
        }
        i = this.buf.indexOf(LF, i + 1);
      }
      if (next < 0) {
        this.scanned = i >= 0 ? i : this.buf.length;
        break;
      }
      out.push(finish(this.buf.subarray(this.start, next)));
      this.start = next;
      this.scanned = next + 1;
    }
    if (final) {
      if (this.start >= 0 && this.buf.length > this.start) out.push(finish(this.buf.subarray(this.start)));
      this.buf = new Uint8Array(0);
      this.start = -1;
      this.scanned = 0;
    } else if (this.start > 0) {
      // Drop what's already been handed out.
      this.buf = this.buf.slice(this.start);
      this.scanned -= this.start;
      this.start = 0;
    }
    return out.filter((m) => m.length > 0);
  }
}
