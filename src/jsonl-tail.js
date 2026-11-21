// Incremental JSONL reader: each call to readNew() returns only the records
// appended since the previous call. Bytes after the last "\n" are held back
// (as raw bytes, so a multi-byte UTF-8 character split across reads survives)
// until the line is complete, so a file being written is never half-parsed.
import fs from 'node:fs';

export class JsonlTail {
  constructor(path) {
    this.path = path;
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.malformed = 0;
  }

  /** @returns {object[]} records appended since the last call */
  readNew() {
    let size;
    try {
      size = fs.statSync(this.path).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      // Truncated or replaced: start over.
      this.offset = 0;
      this.pending = Buffer.alloc(0);
    }
    if (size === this.offset) return [];

    const fd = fs.openSync(this.path, 'r');
    let chunk;
    try {
      const buf = Buffer.alloc(size - this.offset);
      const n = fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += n;
      chunk = buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }

    const data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const lastNl = data.lastIndexOf(0x0a);
    if (lastNl === -1) {
      this.pending = Buffer.from(data);
      return [];
    }
    this.pending = Buffer.from(data.subarray(lastNl + 1));

    const out = [];
    for (const line of data.subarray(0, lastNl).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        this.malformed++;
      }
    }
    return out;
  }
}
