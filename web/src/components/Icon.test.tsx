// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, expect, test } from "vitest";
import { Icon, type IconName } from "./Icon.tsx";

afterEach(cleanup);

test("is decorative by default", () => {
  const { container } = render(<Icon name="overview" />);
  const icon = container.querySelector("svg");
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
  expect(screen.queryByRole("img")).toBeNull();
});

test("can be named when the icon carries meaning by itself", () => {
  render(<Icon name="attention" label="Needs attention" />);
  const icon = screen.getByRole("img", { name: "Needs attention" });
  expect(icon.getAttribute("aria-hidden")).toBeNull();
});

test("supports every command-centre icon with a stable class and size", () => {
  const names: IconName[] = [
    "attention",
    "check",
    "command",
    "overview",
    "pull-request",
    "release",
    "search",
    "workflow",
  ];
  const { container } = render(names.map((name) => <Icon key={name} name={name} size={20} class="toolbar-icon" />));
  const icons = [...container.querySelectorAll("svg")];
  expect(icons).toHaveLength(names.length);
  expect(icons.map((icon) => icon.getAttribute("class"))).toEqual(
    names.map((name) => `ui-icon ui-icon-${name} toolbar-icon`),
  );
  expect(icons.every((icon) => icon.getAttribute("width") === "20" && icon.getAttribute("height") === "20")).toBe(true);
});
