// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, expect, test, vi } from "vitest";
import { CommandPalette, type PaletteCommand } from "./CommandPalette.tsx";

afterEach(cleanup);

function commands(): PaletteCommand[] {
  return [
    {
      id: "overview",
      label: "Open overview",
      group: "Navigation",
      keywords: ["home", "all repositories"],
      shortcut: "G O",
      run: vi.fn(),
    },
    {
      id: "weather",
      label: "Open weather-station",
      group: "Repositories",
      keywords: ["octocat sensors"],
      run: vi.fn(),
    },
    { id: "refresh", label: "Refresh dashboard", group: "Actions", run: vi.fn() },
  ];
}

test("is absent while closed and focuses search when opened", () => {
  const items = commands();
  const view = render(<CommandPalette open={false} commands={items} onClose={() => {}} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(<CommandPalette open commands={items} onClose={() => {}} />);
  expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Search commands" }));
  expect(screen.getAllByRole("option")).toHaveLength(3);
  expect(screen.getByText("Navigation")).toBeTruthy();
  expect(screen.getByText("G O")).toBeTruthy();
});

test("filters across labels, groups, and keywords and reports no matches", () => {
  render(<CommandPalette open commands={commands()} onClose={() => {}} />);
  const search = screen.getByRole("searchbox", { name: "Search commands" });

  fireEvent.input(search, { target: { value: "sensors" } });
  expect(screen.getByRole("option", { name: "Open weather-station" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "Open overview G O" })).toBeNull();

  fireEvent.input(search, { target: { value: "actions refresh" } });
  expect(screen.getByRole("option", { name: "Refresh dashboard" })).toBeTruthy();

  fireEvent.input(search, { target: { value: "missing" } });
  expect(screen.queryByRole("option")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("No commands match “missing”");
});

test("uses arrow keys to choose a command and Enter to run it", () => {
  const items = commands();
  const onClose = vi.fn();
  render(<CommandPalette open commands={items} onClose={onClose} />);
  const search = screen.getByRole("searchbox", { name: "Search commands" });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(search.getAttribute("aria-activedescendant")).toBe("command-palette-option-1");
  fireEvent.keyDown(search, { key: "Enter" });
  expect(items[1]?.run).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

test("wraps arrow navigation and runs a clicked command", () => {
  const items = commands();
  const onClose = vi.fn();
  render(<CommandPalette open commands={items} onClose={onClose} />);
  const search = screen.getByRole("searchbox", { name: "Search commands" });
  fireEvent.keyDown(search, { key: "ArrowUp" });
  expect(search.getAttribute("aria-activedescendant")).toBe("command-palette-option-2");
  fireEvent.click(screen.getByRole("option", { name: "Refresh dashboard" }));
  expect(items[2]?.run).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

test("keeps Tab navigation inside the modal dialog", () => {
  render(<CommandPalette open commands={commands()} onClose={() => {}} />);
  const option = screen.getByRole("option", { name: "Open overview G O" });
  option.focus();
  fireEvent.keyDown(option, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
});

test("Escape closes the dialog and restores focus to its trigger", () => {
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open commands
        </button>
        <CommandPalette open={open} commands={commands()} onClose={() => setOpen(false)} />
      </>
    );
  }
  render(<Host />);
  const trigger = screen.getByRole("button", { name: "Open commands" });
  trigger.focus();
  fireEvent.click(trigger);
  const search = screen.getByRole("searchbox", { name: "Search commands" });
  expect(document.activeElement).toBe(search);
  fireEvent.keyDown(search, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
