// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, type Notifier, type Permission, readSettings } from "../notifications.ts";
import { Settings } from "./Settings.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function notifier() {
  return { notify: vi.fn<Notifier["notify"]>(), test: vi.fn<Notifier["test"]>() };
}

test("lists every kind, on by default, and keeps what is turned off", () => {
  render(<Settings notifier={notifier()} current={() => "granted"} />);
  const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
  expect(boxes).toHaveLength(5);
  expect(boxes.every((box) => box.checked)).toBe(true);

  const checks = screen.getByRole("checkbox", { name: "Checks failed on a pull request" }) as HTMLInputElement;
  fireEvent.click(checks);
  expect(checks.checked).toBe(false);
  expect(readSettings()).toEqual({ ...DEFAULT_SETTINGS, checks: false });

  // Kept for the next visit.
  cleanup();
  render(<Settings notifier={notifier()} current={() => "granted"} />);
  expect((screen.getByRole("checkbox", { name: "Checks failed on a pull request" }) as HTMLInputElement).checked).toBe(
    false,
  );
});

test("asks for the browser's permission, and once given offers a test", async () => {
  const ask = vi.fn(async (): Promise<Permission> => "granted");
  const one = notifier();
  render(<Settings notifier={one} ask={ask} current={() => "default"} />);
  fireEvent.click(screen.getByRole("button", { name: "Allow notifications" }));
  fireEvent.click(await screen.findByRole("button", { name: "Send a test" }));
  expect(ask).toHaveBeenCalledOnce();
  expect(one.test).toHaveBeenCalledOnce();
});

test("says how to unblock notifications, or that the browser has none", () => {
  render(<Settings notifier={notifier()} current={() => "denied"} />);
  expect(screen.getByText(/Notifications are blocked for this site/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Allow notifications" })).toBeNull();
  cleanup();
  render(<Settings notifier={notifier()} current={() => "unsupported"} />);
  expect(screen.getByText("This browser can't show notifications.")).toBeTruthy();
});
