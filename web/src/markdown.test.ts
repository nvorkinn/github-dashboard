// @vitest-environment jsdom
// DOMPurify is made for real browsers and jsdom; it lets markup through in happy-dom.
import { expect, test } from "vitest";
import { renderMarkdown } from "./markdown.ts";

const PR = "https://github.com/octocat/hello/pull/7";

function html(text: string, base?: string): string {
  const element = document.createElement("div");
  element.append(renderMarkdown(text, base));
  return element.innerHTML;
}

test("renders GitHub's Markdown: headings, lists, code, tables and line breaks", () => {
  const out = html(
    "## What\n\n- one\n- `two`\n\nfirst line\nsecond line\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```",
  );
  expect(out).toContain("<h2>What</h2>");
  expect(out).toContain("<li><code>two</code></li>");
  expect(out).toContain("first line<br>second line");
  expect(out).toContain("<table>");
  expect(out).toContain("const x = 1;");
});

test("drops scripts, event handlers, styles, frames and forms", () => {
  const out = html(
    '<script>alert(1)</script><img src=x onerror="alert(2)"><p style="color:red" onclick="alert(3)">hi</p>' +
      "<iframe src='https://evil.example'></iframe><form><input name=q></form>",
  );
  expect(out).not.toMatch(/script|alert|onerror|onclick|style=|iframe|<form|<input/i);
  expect(out).toContain("<p>hi</p>");
});

test("keeps the words of a link that isn't to a web page or email address, but not the link", () => {
  const out = html('[click](javascript:alert(1)) and <a href="data:text/html,x">data</a>');
  expect(out).not.toMatch(/javascript:|data:/);
  expect(out).toContain("click");
  expect(out).toContain("data");
});

test("keeps HTML comments, such as a PR template's, out of sight", () => {
  expect(html("<!-- hidden note -->\nShown")).not.toContain("hidden note");
});

test("opens links in a new tab, resolving relative ones from the PR", () => {
  const out = html("[docs](https://example.com/docs) [file](files) [top](#what) <mail@example.com>", PR);
  expect(out).toContain('href="https://example.com/docs" target="_blank" rel="noopener noreferrer"');
  expect(out).toContain('href="https://github.com/octocat/hello/pull/files"');
  expect(out).toContain('href="#what"');
  expect(out).not.toContain('href="#what" target');
  expect(out).toContain('href="mailto:mail@example.com"');
});

test("shows images as links to them, since the page may not load them", () => {
  const out = html(
    "![screenshot](https://github.com/user-attachments/assets/1) [![badge](https://img.example/b.svg)](https://ci.example)",
  );
  expect(out).not.toContain("<img");
  expect(out).toContain(
    '<a href="https://github.com/user-attachments/assets/1" target="_blank" rel="noopener noreferrer">[Image: screenshot]</a>',
  );
  expect(out).toContain('<a href="https://ci.example/" target="_blank" rel="noopener noreferrer">[badge]</a>');
});

test("shows task lists with checkboxes that can't be ticked", () => {
  const element = document.createElement("div");
  element.append(renderMarkdown("- [x] done\n- [ ] to do"));
  const boxes = [...element.querySelectorAll("input")];
  expect(boxes).toHaveLength(2);
  expect(boxes.every((box) => box.type === "checkbox" && box.disabled)).toBe(true);
  expect(boxes[0]?.checked).toBe(true);
});

test("keeps collapsible sections", () => {
  expect(html("<details><summary>More</summary>\n\nInside\n\n</details>")).toMatch(
    /<details><summary>More<\/summary>[\s\S]*Inside[\s\S]*<\/details>/,
  );
});
