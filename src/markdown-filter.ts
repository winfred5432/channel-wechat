/**
 * Streaming markdown filter that strips the small subset of markdown syntax
 * WeChat tends to render poorly, while keeping code, tables, and bold intact.
 *
 * The filter is intentionally conservative:
 * - code fences and inline code are preserved verbatim
 * - tables are preserved because pipes are not rewritten
 * - bold markers are preserved
 * - images are removed entirely
 * - H5/H6 headings have their leading markdown markers stripped
 * - CJK italics / bold-italics have markers stripped, matching the official
 *   plugin's behavior for Chinese content
 */
export class StreamingMarkdownFilter {
  private buffer = "";
  private inFence = false;
  private atLineStart = true;
  private inline:
    | { type: "image" | "bold3" | "italic" | "ubold3" | "uitalic"; acc: string }
    | null = null;

  feed(delta: string): string {
    this.buffer += delta;
    return this.pump(false);
  }

  flush(): string {
    return this.pump(true);
  }

  private pump(eof: boolean): string {
    let out = "";
    while (this.buffer) {
      const before = this.buffer;
      const beforeLineStart = this.atLineStart;
      const beforeFence = this.inFence;
      const beforeInline = this.inline;

      if (this.inFence) out += this.pumpFence(eof);
      else if (this.inline) out += this.pumpInline(eof);
      else if (this.atLineStart) out += this.pumpLineStart(eof);
      else out += this.pumpBody(eof);

      if (
        this.buffer === before &&
        this.atLineStart === beforeLineStart &&
        this.inFence === beforeFence &&
        this.inline === beforeInline
      ) {
        break;
      }
    }

    if (eof && this.inline) {
      const prefix: Record<string, string> = {
        image: "![",
        bold3: "***",
        italic: "*",
        ubold3: "___",
        uitalic: "_",
      };
      out += `${prefix[this.inline.type] ?? ""}${this.inline.acc}`;
      this.inline = null;
    }

    return out;
  }

  private pumpFence(eof: boolean): string {
    if (this.atLineStart) {
      if (this.buffer.length < 3 && !eof) return "";
      if (this.buffer.startsWith("```")) {
        const endOfLine = this.buffer.indexOf("\n", 3);
        if (endOfLine !== -1) {
          const line = this.buffer.slice(0, endOfLine + 1);
          this.buffer = this.buffer.slice(endOfLine + 1);
          this.atLineStart = true;
          this.inFence = false;
          return line;
        }
        if (eof) {
          const tail = this.buffer;
          this.buffer = "";
          this.atLineStart = false;
          this.inFence = false;
          return tail;
        }
        return "";
      }
      this.atLineStart = false;
    }

    const newline = this.buffer.indexOf("\n");
    if (newline !== -1) {
      const chunk = this.buffer.slice(0, newline + 1);
      this.buffer = this.buffer.slice(newline + 1);
      this.atLineStart = true;
      return chunk;
    }

    const chunk = this.buffer;
    this.buffer = "";
    return chunk;
  }

  private pumpLineStart(eof: boolean): string {
    const b = this.buffer;

    if (b[0] === "\n") {
      this.buffer = b.slice(1);
      return "\n";
    }

    if (b[0] === "`") {
      if (b.length < 3 && !eof) return "";
      if (b.startsWith("```")) {
        const endOfLine = b.indexOf("\n", 3);
        if (endOfLine !== -1) {
          const line = b.slice(0, endOfLine + 1);
          this.buffer = b.slice(endOfLine + 1);
          this.atLineStart = true;
          this.inFence = true;
          return line;
        }
        if (eof) {
          this.buffer = "";
          return b;
        }
        return "";
      }
      this.atLineStart = false;
      return "";
    }

    if (b[0] === "#") {
      let count = 0;
      while (count < b.length && b[count] === "#") count++;
      if (count === b.length && !eof) return "";

      if (count >= 5 && count <= 6 && count < b.length && b[count] === " ") {
        this.buffer = b.slice(count + 1);
        this.atLineStart = false;
        return "";
      }

      this.atLineStart = false;
      return "";
    }

    if (b[0] === " " || b[0] === "\t") {
      if (b.search(/[^ \t]/) === -1 && !eof) return "";
      this.atLineStart = false;
      return "";
    }

    if (b[0] === "-" || b[0] === "*" || b[0] === "_") {
      const marker = b[0];
      let i = 0;
      while (i < b.length && (b[i] === marker || b[i] === " ")) i++;
      if (i === b.length && !eof) return "";
      if (i === b.length || b[i] === "\n") {
        let hits = 0;
        for (let j = 0; j < i; j++) {
          if (b[j] === marker) hits++;
        }
        if (hits >= 3) {
          if (i < b.length) {
            this.buffer = b.slice(i + 1);
            this.atLineStart = true;
            return b.slice(0, i + 1);
          }
          this.buffer = "";
          return b;
        }
      }
      this.atLineStart = false;
      return "";
    }

    this.atLineStart = false;
    return "";
  }

  private pumpBody(eof: boolean): string {
    let out = "";
    let i = 0;
    while (i < this.buffer.length) {
      const c = this.buffer[i];

      if (c === "\n") {
        out += this.buffer.slice(0, i + 1);
        this.buffer = this.buffer.slice(i + 1);
        this.atLineStart = true;
        return out;
      }

      if (c === "!" && i + 1 < this.buffer.length && this.buffer[i + 1] === "[") {
        out += this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 2);
        this.inline = { type: "image", acc: "" };
        return out;
      }

      if (c === "~") {
        i++;
        continue;
      }

      if (c === "*") {
        if (i + 2 < this.buffer.length && this.buffer[i + 1] === "*" && this.buffer[i + 2] === "*") {
          out += this.buffer.slice(0, i);
          this.buffer = this.buffer.slice(i + 3);
          this.inline = { type: "bold3", acc: "" };
          return out;
        }
        if (i + 1 < this.buffer.length && this.buffer[i + 1] === "*") {
          i += 2;
          continue;
        }
        if (i + 1 < this.buffer.length && this.buffer[i + 1] !== " " && this.buffer[i + 1] !== "\n") {
          out += this.buffer.slice(0, i);
          this.buffer = this.buffer.slice(i + 1);
          this.inline = { type: "italic", acc: "" };
          return out;
        }
        i++;
        continue;
      }

      if (c === "_") {
        if (i + 2 < this.buffer.length && this.buffer[i + 1] === "_" && this.buffer[i + 2] === "_") {
          out += this.buffer.slice(0, i);
          this.buffer = this.buffer.slice(i + 3);
          this.inline = { type: "ubold3", acc: "" };
          return out;
        }
        if (i + 1 < this.buffer.length && this.buffer[i + 1] === "_") {
          i += 2;
          continue;
        }
        if (i + 1 < this.buffer.length && this.buffer[i + 1] !== " " && this.buffer[i + 1] !== "\n") {
          out += this.buffer.slice(0, i);
          this.buffer = this.buffer.slice(i + 1);
          this.inline = { type: "uitalic", acc: "" };
          return out;
        }
        i++;
        continue;
      }

      i++;
    }

    let hold = 0;
    if (!eof) {
      if (this.buffer.endsWith("**")) hold = 2;
      else if (this.buffer.endsWith("__")) hold = 2;
      else if (this.buffer.endsWith("*")) hold = 1;
      else if (this.buffer.endsWith("_")) hold = 1;
      else if (this.buffer.endsWith("!")) hold = 1;
    }
    out += this.buffer.slice(0, this.buffer.length - hold);
    this.buffer = hold > 0 ? this.buffer.slice(-hold) : "";
    return out;
  }

  private pumpInline(_eof: boolean): string {
    if (!this.inline) return "";

    this.inline.acc += this.buffer;
    this.buffer = "";

    switch (this.inline.type) {
      case "bold3": {
        const end = this.inline.acc.indexOf("***");
        if (end === -1) return "";
        const content = this.inline.acc.slice(0, end);
        this.buffer = this.inline.acc.slice(end + 3);
        this.inline = null;
        return StreamingMarkdownFilter.containsCjk(content) ? content : `***${content}***`;
      }
      case "ubold3": {
        const end = this.inline.acc.indexOf("___");
        if (end === -1) return "";
        const content = this.inline.acc.slice(0, end);
        this.buffer = this.inline.acc.slice(end + 3);
        this.inline = null;
        return StreamingMarkdownFilter.containsCjk(content) ? content : `___${content}___`;
      }
      case "italic": {
        for (let i = 0; i < this.inline.acc.length; i++) {
          const ch = this.inline.acc[i];
          if (ch === "\n") {
            const out = `*${this.inline.acc.slice(0, i + 1)}`;
            this.buffer = this.inline.acc.slice(i + 1);
            this.inline = null;
            this.atLineStart = true;
            return out;
          }
          if (ch === "*") {
            if (i + 1 < this.inline.acc.length && this.inline.acc[i + 1] === "*") {
              i++;
              continue;
            }
            const content = this.inline.acc.slice(0, i);
            this.buffer = this.inline.acc.slice(i + 1);
            this.inline = null;
            return StreamingMarkdownFilter.containsCjk(content) ? content : `*${content}*`;
          }
        }
        return "";
      }
      case "uitalic": {
        for (let i = 0; i < this.inline.acc.length; i++) {
          const ch = this.inline.acc[i];
          if (ch === "\n") {
            const out = `_${this.inline.acc.slice(0, i + 1)}`;
            this.buffer = this.inline.acc.slice(i + 1);
            this.inline = null;
            this.atLineStart = true;
            return out;
          }
          if (ch === "_") {
            if (i + 1 < this.inline.acc.length && this.inline.acc[i + 1] === "_") {
              i++;
              continue;
            }
            const content = this.inline.acc.slice(0, i);
            this.buffer = this.inline.acc.slice(i + 1);
            this.inline = null;
            return StreamingMarkdownFilter.containsCjk(content) ? content : `_${content}_`;
          }
        }
        return "";
      }
      case "image": {
        const close = this.inline.acc.indexOf("]");
        if (close === -1) return "";
        if (close + 1 >= this.inline.acc.length) return "";
        if (this.inline.acc[close + 1] !== "(") {
          const out = `![${this.inline.acc.slice(0, close + 1)}`;
          this.buffer = this.inline.acc.slice(close + 1);
          this.inline = null;
          return out;
        }
        const end = this.inline.acc.indexOf(")", close + 2);
        if (end === -1) return "";
        this.buffer = this.inline.acc.slice(end + 1);
        this.inline = null;
        return "";
      }
    }

    return "";
  }

  private static containsCjk(text: string): boolean {
    return /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/.test(text);
  }
}
