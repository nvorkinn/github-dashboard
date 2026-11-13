// @vitest-environment jsdom
// jsdom rather than happy-dom, for DOMPurify (see markdown.test.ts).
import { cleanup, render } from "@testing-library/preact";
import { afterEach, expect, test } from "vitest";
import { Markdown } from "./Markdown.tsx";

afterEach(cleanup);

test("shows a PR description as formatted text and follows changes to it", () => {
  const { container, rerender } = render(<Markdown text={"Fixes **this**\n\n- [x] tested"} class="extra" />);
  const element = container.querySelector(".markdown.extra");
  expect(element?.querySelector("strong")?.textContent).toBe("this");
  expect(element?.querySelector("input[type=checkbox]")).toBeTruthy();
  rerender(<Markdown text="# Now a heading" class="extra" />);
  expect(element?.querySelector("h1")?.textContent).toBe("Now a heading");
  expect(element?.querySelector("strong")).toBeNull();
});
