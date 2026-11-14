import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { parseYaml, type Yaml, YamlError } from "./workflow_yaml.ts";

// Real workflow files: this repository's own, and the old dashboard's (copied into fixtures/).
const DIRS = [".github/workflows", "web/src/github/fixtures/countdown-server"];
const FILES = DIRS.flatMap((dir) => readdirSync(dir).map((file) => join(dir, file)));

/** What the full YAML library makes of a text, with every scalar as the string it was written as. */
function reference(text: string, merge = false): Yaml {
  const strings = (value: unknown): Yaml => {
    if (value === null || value === undefined) {
      return null;
    }
    if (Array.isArray(value)) {
      return value.map(strings);
    }
    if (typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strings(v)]));
    }
    return String(value);
  };
  return strings(parse(text, { merge }));
}

test.each(FILES)("reads %s as the YAML library does", (file) => {
  const text = readFileSync(file, "utf8");
  expect(parseYaml(text)).toEqual(reference(text));
});

test("reads mappings, sequences and flow collections", () => {
  const text = `
# A comment
name: Release   # and another
on:
  push:
    tags: ["v*"]
jobs:
  a:
    needs: [b, "c", 'd e']
    strategy:
      matrix: {os: [linux, mac], "x": 1}
  b:
    needs:
    - c
    - 'it''s'
  c:
    steps:
      - name: x
        run: |
          echo "a: b" # not a comment
          # nor this
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
    long: >
      folded
      text
    plain: one
      two
`;
  expect(parseYaml(text)).toEqual(reference(text));
});

test("reads anchors, aliases and merge keys", () => {
  const text = `
defaults: &base
  runs-on: ubuntu-latest
  needs: [a]
jobs:
  a: {}
  b:
    <<: *base
    name: B
  c: *base
`;
  expect(parseYaml(text)).toEqual(reference(text, true));
});

test("reads quoted keys, a document marker and a flow list over several lines", () => {
  const text = `---
"on": push
'jobs':
  x:
    needs: [
      a,
      b,
    ]
    name: "say \\"hi\\" \\u00e9"
`;
  expect(parseYaml(text)).toEqual(reference(text));
});

test.each([
  ["a tab in the indentation", "jobs:\n\tx: {}"],
  ["an unclosed bracket", "jobs: [a, b"],
  ["an unknown alias", "jobs: *nope"],
  ["a complex key", "? a\n: b"],
  ["a second document", "a: 1\n---\nb: 2"],
  ["bad indentation", "jobs:\n    a: 1\n  b: 2"],
  ["an unclosed quote", 'name: "abc'],
])("refuses %s", (_, text) => {
  expect(() => parseYaml(text)).toThrow(YamlError);
});
