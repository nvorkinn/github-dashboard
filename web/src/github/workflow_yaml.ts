/**
 * Just enough YAML to read a GitHub Actions workflow file: block mappings and sequences, plain and quoted scalars,
 * flow collections (`[a, b]`, `{a: 1}`), block scalars (`|` and `>`, kept as text), comments, anchors, aliases and
 * merge keys. Every scalar stays a string (or null), as only names are looked at. Anything else it doesn't know, such
 * as a complex key or more than one document, fails with a `YamlError` rather than being read wrong.
 */

export type Yaml = string | null | Yaml[] | { [key: string]: Yaml };

export class YamlError extends Error {
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `${message} (line ${line + 1})`);
    this.name = "YamlError";
  }
}

type Line = { indent: number; text: string; number: number };

export function parseYaml(source: string): Yaml {
  return new Parser(source).document();
}

class Parser {
  raw: string[];
  at = 0;
  anchors = new Map<string, Yaml>();

  constructor(source: string) {
    this.raw = source.replace(/^﻿/, "").split(/\r?\n/);
  }

  document(): Yaml {
    let line = this.peek();
    if (line?.indent === 0 && /^---(\s|$)/.test(line.text)) {
      const rest = line.text.slice(3).trim();
      if (rest) {
        throw new YamlError("content after ---", line.number);
      }
      this.at = line.number + 1;
      line = this.peek();
    }
    if (!line) {
      return null;
    }
    const value = this.block(line.indent);
    const after = this.peek();
    if (after && !(after.indent === 0 && after.text === "...")) {
      throw new YamlError("unexpected text", after.number);
    }
    return value;
  }

  /** The next line with content, its comment taken off; undefined at the end. Doesn't move past it. */
  peek(): Line | undefined {
    for (let n = this.at; n < this.raw.length; n++) {
      const raw = this.raw[n] ?? "";
      const text = stripComment(raw).trimEnd();
      if (text.trim() === "") {
        continue;
      }
      const indent = raw.length - raw.trimStart().length;
      if (raw.slice(0, indent).includes("\t")) {
        throw new YamlError("tab in indentation", n);
      }
      return { indent, text: text.slice(indent), number: n };
    }
    return undefined;
  }

  /** The node whose first line is the next line, indented by `indent`. */
  block(indent: number, line = this.peek()): Yaml {
    if (!line) {
      return null;
    }
    if (isItem(line.text)) {
      return this.sequence(indent, line);
    }
    if (keyEnd(line.text) !== undefined) {
      return this.mapping(indent, line);
    }
    this.at = line.number + 1;
    return this.value(line.text, indent - 1, line.number);
  }

  sequence(indent: number, first: Line): Yaml[] {
    const items: Yaml[] = [];
    let line: Line | undefined = first;
    while (line && line.indent === indent && isItem(line.text)) {
      const rest = line.text.slice(1).trimStart();
      if (rest === "") {
        this.at = line.number + 1;
        const next = this.peek();
        items.push(next && next.indent > indent ? this.block(next.indent, next) : null);
      } else {
        // `- key: value` starts a mapping (or `- - x` a sequence) whose further lines line up with `key`.
        const inner = { indent: indent + (line.text.length - rest.length), text: rest, number: line.number };
        items.push(this.block(inner.indent, inner));
      }
      line = this.peek();
    }
    if (line && line.indent > indent) {
      throw new YamlError("bad indentation", line.number);
    }
    return items;
  }

  mapping(indent: number, first: Line): { [key: string]: Yaml } {
    const map: { [key: string]: Yaml } = {};
    let line: Line | undefined = first;
    while (line && line.indent === indent) {
      const end = keyEnd(line.text);
      if (end === undefined) {
        throw new YamlError("expected a key", line.number);
      }
      const keyText = line.text.slice(0, end).trim();
      if (keyText.startsWith("?")) {
        throw new YamlError("complex keys aren't supported", line.number);
      }
      const key = unquote(keyText, line.number);
      const rest = line.text.slice(end + 1).trim();
      this.at = line.number + 1;
      let value: Yaml;
      const { anchor, rest: unanchored } = takeAnchor(rest);
      if (unanchored === "") {
        const next = this.peek();
        if (next && next.indent > indent) {
          value = this.block(next.indent, next);
        } else if (next && next.indent === indent && isItem(next.text)) {
          // A sequence may sit at its key's own indentation.
          value = this.sequence(indent, next);
        } else {
          value = null;
        }
      } else {
        value = this.value(unanchored, indent, line.number);
      }
      if (anchor) {
        this.anchors.set(anchor, value);
      }
      if (key === "<<" && value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value)) {
          if (!(k in map)) {
            map[k] = v;
          }
        }
      } else {
        map[key] = value;
      }
      line = this.peek();
    }
    if (line && line.indent > indent) {
      throw new YamlError("bad indentation", line.number);
    }
    return map;
  }

  /** A value that starts on its key's (or item's) own line, at `text`. `indent` is its parent's. */
  value(text: string, indent: number, number: number): Yaml {
    const { anchor, rest } = takeAnchor(text);
    let value: Yaml;
    if (/^[|>]/.test(rest)) {
      if (!/^[|>][+-]?[1-9]?[+-]?$/.test(rest)) {
        throw new YamlError("bad block scalar", number);
      }
      value = this.blockScalar(indent, rest[0] === ">", rest.includes("-") ? "-" : rest.includes("+") ? "+" : "");
    } else if (rest.startsWith("*")) {
      const name = rest.slice(1);
      if (!this.anchors.has(name)) {
        throw new YamlError(`unknown alias ${name}`, number);
      }
      value = this.anchors.get(name) ?? null;
    } else if (rest.startsWith("[") || rest.startsWith("{")) {
      // A flow collection can go on over the lines after it.
      let whole = rest;
      while (!balanced(whole)) {
        const next = this.peek();
        if (!next) {
          throw new YamlError("unclosed bracket", number);
        }
        whole += ` ${next.text}`;
        this.at = next.number + 1;
      }
      const flow = new Flow(whole, number, this.anchors);
      value = flow.value();
      flow.end();
    } else if (rest.startsWith("!")) {
      throw new YamlError("tags aren't supported", number);
    } else {
      // A plain scalar can go on over more indented lines.
      let whole = rest;
      for (let next = this.peek(); next && next.indent > indent; next = this.peek()) {
        if (whole.startsWith('"') || whole.startsWith("'")) {
          if (QUOTED.test(whole)) {
            break;
          }
        } else if (keyEnd(next.text) !== undefined || isItem(next.text)) {
          break;
        }
        whole += ` ${next.text}`;
        this.at = next.number + 1;
      }
      value = scalar(whole, number);
    }
    if (anchor) {
      this.anchors.set(anchor, value);
    }
    return value;
  }

  /** The lines of a `|` or `>` scalar, from the next line on: blank ones, and those indented past `indent`. */
  blockScalar(indent: number, folded: boolean, chomp: string): string {
    const lines: string[] = [];
    let n = this.at;
    let contentIndent: number | undefined;
    for (; n < this.raw.length; n++) {
      const raw = this.raw[n] ?? "";
      if (raw.trim() === "") {
        lines.push("");
        continue;
      }
      const own = raw.length - raw.trimStart().length;
      if (own <= indent) {
        break;
      }
      contentIndent ??= own;
      if (own < contentIndent) {
        break;
      }
      lines.push(raw.slice(contentIndent));
    }
    this.at = n;
    let trailing = 0;
    while (lines.length > 0 && lines.at(-1) === "") {
      lines.pop();
      trailing++;
    }
    if (lines.length === 0) {
      return "";
    }
    let body = lines.join("\n");
    if (folded) {
      // A line break between two lines of text becomes a space; blank lines and more indented lines keep theirs.
      body = "";
      let previous: "none" | "text" | "more" | "blank" = "none";
      let lastText: "text" | "more" = "text";
      for (const line of lines) {
        if (line === "") {
          body += "\n";
          previous = "blank";
          continue;
        }
        const kind = line.startsWith(" ") || line.startsWith("\t") ? "more" : "text";
        if (previous === "text" || previous === "more") {
          body += kind === "more" || previous === "more" ? "\n" : " ";
        } else if (previous === "blank" && (kind === "more" || lastText === "more")) {
          body += "\n";
        }
        body += line;
        previous = kind;
        lastText = kind;
      }
    }
    if (chomp === "-") {
      return body;
    }
    return chomp === "+" ? `${body}\n${"\n".repeat(trailing)}` : `${body}\n`;
  }
}

/** Flow collections: `[a, "b", {c: d}]`. */
class Flow {
  at = 0;
  text: string;
  number: number;
  anchors: Map<string, Yaml>;

  constructor(text: string, number: number, anchors: Map<string, Yaml>) {
    this.text = text;
    this.number = number;
    this.anchors = anchors;
  }

  fail(message: string): never {
    throw new YamlError(message, this.number);
  }

  space(): void {
    while (this.text[this.at] === " " || this.text[this.at] === "\t") {
      this.at++;
    }
  }

  end(): void {
    this.space();
    if (this.at < this.text.length) {
      this.fail("text after a flow collection");
    }
  }

  value(): Yaml {
    this.space();
    const c = this.text[this.at];
    if (c === "[") {
      this.at++;
      const items: Yaml[] = [];
      for (;;) {
        this.space();
        if (this.text[this.at] === "]") {
          this.at++;
          return items;
        }
        items.push(this.value());
        this.space();
        if (this.text[this.at] === ",") {
          this.at++;
        } else if (this.text[this.at] !== "]") {
          this.fail("expected , or ]");
        }
      }
    }
    if (c === "{") {
      this.at++;
      const map: { [key: string]: Yaml } = {};
      for (;;) {
        this.space();
        if (this.text[this.at] === "}") {
          this.at++;
          return map;
        }
        const key = this.scalar();
        this.space();
        let value: Yaml = null;
        if (this.text[this.at] === ":") {
          this.at++;
          this.space();
          value = this.text[this.at] === "," || this.text[this.at] === "}" ? null : this.value();
        }
        map[key ?? ""] = value;
        this.space();
        if (this.text[this.at] === ",") {
          this.at++;
        } else if (this.text[this.at] !== "}") {
          this.fail("expected , or }");
        }
      }
    }
    if (c === "*") {
      const match = /^\*([^\s,[\]{}]+)/.exec(this.text.slice(this.at));
      if (!match?.[1] || !this.anchors.has(match[1])) {
        this.fail("unknown alias");
      }
      this.at += match[0].length;
      return this.anchors.get(match[1]) ?? null;
    }
    return this.scalar();
  }

  scalar(): string | null {
    const rest = this.text.slice(this.at);
    const quoted = QUOTED.exec(rest);
    if (quoted) {
      this.at += quoted[0].length;
      return unquote(quoted[0], this.number);
    }
    // A plain scalar ends at a flow indicator, or at a `:` that ends a key.
    const plain = /^(?:[^,[\]{}:]|:(?=[^\s,[\]{}]))*/.exec(rest);
    const text = plain?.[0] ?? "";
    this.at += text.length;
    return scalar(text.trim(), this.number);
  }
}

function isItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

/**
 * Where a line's key ends (the index of its `:`), when the line is `key: …` or `key:`; undefined otherwise. The
 * colon must be followed by a space or end the line, and be outside quotes and brackets.
 */
function keyEnd(text: string): number | undefined {
  if (/^[[{|>*&!]/.test(text) || isItem(text)) {
    return undefined;
  }
  let i = 0;
  if (text[0] === '"' || text[0] === "'") {
    const quoted = QUOTED.exec(text);
    if (!quoted) {
      return undefined;
    }
    i = quoted[0].length;
    const after = /^\s*:(\s|$)/.exec(text.slice(i));
    return after ? i + after[0].indexOf(":") : undefined;
  }
  for (; i < text.length; i++) {
    if (text[i] === ":" && (i + 1 === text.length || text[i + 1] === " " || text[i + 1] === "\t")) {
      return i;
    }
  }
  return undefined;
}

/** A line without its comment: from a `#` at its start or after a space, outside quotes. */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (quote === '"' && c === "\\") {
        i++;
      } else if (c === quote) {
        quote = undefined;
      }
    } else if (c === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:-]/.test(line[i - 1] ?? ""))) {
      quote = c;
    }
  }
  return line;
}

function takeAnchor(text: string): { anchor: string | undefined; rest: string } {
  const match = /^&([^\s,[\]{}]+)\s*/.exec(text);
  return match ? { anchor: match[1], rest: text.slice(match[0].length) } : { anchor: undefined, rest: text };
}

function balanced(text: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (quote === '"' && c === "\\") {
        i++;
      } else if (c === quote) {
        quote = undefined;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "[" || c === "{") {
      depth++;
    } else if (c === "]" || c === "}") {
      depth--;
    }
  }
  return depth <= 0 && quote === undefined;
}

/** A double- or single-quoted scalar at the start of a text. */
const QUOTED = /^"(?:[^"\\]|\\.)*"|^'(?:[^']|'')*'/;

function scalar(text: string, number: number): string | null {
  if (text.startsWith('"') || text.startsWith("'")) {
    const quoted = QUOTED.exec(text);
    if (!quoted || quoted[0].length !== text.length) {
      throw new YamlError("bad quoted scalar", number);
    }
    return unquote(text, number);
  }
  if (text === "" || text === "~" || text === "null" || text === "Null" || text === "NULL") {
    return null;
  }
  return text;
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
  '"': '"',
  "\\": "\\",
  "/": "/",
  " ": " ",
};

function unquote(text: string, number: number): string {
  if (text.startsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text.startsWith('"')) {
    return text.slice(1, -1).replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (_, e: string) => {
      if (e.length > 1) {
        return String.fromCharCode(Number.parseInt(e.slice(1), 16));
      }
      const plain = ESCAPES[e];
      if (plain === undefined) {
        throw new YamlError(`unknown escape \\${e}`, number);
      }
      return plain;
    });
  }
  return text;
}
