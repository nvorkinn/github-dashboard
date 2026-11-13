// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, type Notifier, type Permission, readSettings } from "../notifications.ts";
import { isSafariTab, Settings } from "./Settings.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
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

test("asks how many columns the lanes take on a wide screen, where that can be chosen", () => {
  const chosen: number[] = [];
  render(
    <Settings
      notifier={notifier()}
      current={() => "granted"}
      laneColumns={2}
      onLaneColumns={(columns) => chosen.push(columns)}
    />,
  );
  expect((screen.getByRole("radio", { name: "Two columns" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "One column, each lane the full width" }));
  expect(chosen).toEqual([1]);
});

test("without a way to choose, the lanes' columns aren't asked", () => {
  render(<Settings notifier={notifier()} current={() => "granted"} />);
  expect(screen.queryByRole("group", { name: "Lanes on a wide screen" })).toBeNull();
  expect(screen.queryByRole("radio", { name: "Two columns" })).toBeNull();
});

test("offers auto, light and dark, starting on auto, and applies the one chosen", () => {
  render(<Settings notifier={notifier()} current={() => "granted"} />);
  const auto = screen.getByRole("radio", { name: /Auto/ }) as HTMLInputElement;
  const light = screen.getByRole("radio", { name: "Light" }) as HTMLInputElement;
  const dark = screen.getByRole("radio", { name: "Dark" }) as HTMLInputElement;
  expect(auto.checked).toBe(true);

  fireEvent.click(dark);
  expect(dark.checked).toBe(true);
  expect(document.documentElement.dataset.theme).toBe("dark");

  fireEvent.click(light);
  expect(document.documentElement.dataset.theme).toBe("light");

  fireEvent.click(auto);
  expect(auto.checked).toBe(true);
  expect(document.documentElement.dataset.theme).toBeUndefined();
});

test("in a Safari tab, says how to get the dashboard's icon on notifications", () => {
  render(<Settings notifier={notifier()} current={() => "granted"} safariTab />);
  expect(screen.getByText(/add it to the Dock/)).toBeTruthy();
  cleanup();
  render(<Settings notifier={notifier()} current={() => "granted"} safariTab={false} />);
  expect(screen.queryByText(/add it to the Dock/)).toBeNull();
});

test.each([
  [
    "Safari",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    false,
    true,
  ],
  [
    "Safari from the Dock",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    true,
    false,
  ],
  [
    "Chrome",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    false,
    false,
  ],
  [
    "Edge",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    false,
    false,
  ],
])("%s: is a Safari tab or not", (_name, agent, standalone, expected) => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: standalone && query === "(display-mode: standalone)" }));
  expect(isSafariTab()).toBe(expected);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
