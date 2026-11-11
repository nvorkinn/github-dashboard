// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { Notice } from "../model.ts";
import { NotificationCentre } from "./NotificationCentre.tsx";

afterEach(cleanup);

const merged: Notice = {
  type: "merged",
  key: "merged:octo/app#7",
  repo: "octo/app",
  headline: "Merged octo/app#7: Add parcels",
  url: "https://github.com/octo/app/pull/7",
};

const waiting: Notice = {
  type: "waiting",
  key: "waiting:octo/api:91",
  repo: "octo/api",
  headline: "Release waits for production approval",
  url: "https://github.com/octo/api/actions/runs/91",
};

function renderCentre(fields: { notices?: Notice[]; open?: boolean } = {}) {
  const callbacks = { onOpen: vi.fn(), onClose: vi.fn(), onClear: vi.fn() };
  const notices = fields.notices ?? [merged, waiting];
  const view = render(<NotificationCentre notices={notices} open={fields.open ?? false} {...callbacks} />);
  return { ...view, callbacks, notices };
}

test("reports unread notices from its controlled disclosure trigger", () => {
  const { callbacks } = renderCentre();
  const trigger = screen.getByRole("button", { name: "Notifications, 2 unread" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.textContent).toBe("Notifications2");
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger);
  expect(callbacks.onOpen).toHaveBeenCalledOnce();
});

test("lists notice kinds and repositories, with safe external links", () => {
  renderCentre({ open: true });
  const dialog = screen.getByRole("dialog", { name: "Notifications 2" });
  expect(within(dialog).getByText("Pull request merged")).toBeTruthy();
  expect(within(dialog).getByText("Waiting for your approval")).toBeTruthy();
  expect(within(dialog).getByText("octo/app")).toBeTruthy();
  expect(within(dialog).getByText("octo/api")).toBeTruthy();
  const link = within(dialog).getByRole("link", { name: merged.headline });
  expect(link.getAttribute("href")).toBe(merged.url);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(within(dialog).getByRole("link", { name: waiting.headline })).toBeTruthy();
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
});

test("marks visible notices read and counts a new one after closing", () => {
  const callbacks = { onOpen: vi.fn(), onClose: vi.fn(), onClear: vi.fn() };
  const view = render(<NotificationCentre notices={[merged]} open={false} {...callbacks} />);
  expect(screen.getByRole("button", { name: "Notifications, 1 unread" })).toBeTruthy();

  view.rerender(<NotificationCentre notices={[merged]} open {...callbacks} />);
  expect(screen.getByRole("button", { name: "Notifications, 0 unread" })).toBeTruthy();

  view.rerender(<NotificationCentre notices={[merged]} open={false} {...callbacks} />);
  view.rerender(<NotificationCentre notices={[waiting, merged]} open={false} {...callbacks} />);
  expect(screen.getByRole("button", { name: "Notifications, 1 unread" })).toBeTruthy();
});

test("closes with Escape, clears history, and restores focus after closing", () => {
  const callbacks = { onOpen: vi.fn(), onClose: vi.fn(), onClear: vi.fn() };
  const view = render(<NotificationCentre notices={[merged]} open {...callbacks} />);
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Clear notifications" }));
  expect(callbacks.onClear).toHaveBeenCalledOnce();

  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(callbacks.onClose).toHaveBeenCalledOnce();
  view.rerender(<NotificationCentre notices={[merged]} open={false} {...callbacks} />);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Notifications, 0 unread" }));
});

test("shows an honest empty state without a clear action", () => {
  renderCentre({ notices: [], open: true });
  const dialog = screen.getByRole("dialog", { name: "Notifications 0" });
  expect(within(dialog).getByText("No notifications yet.")).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: "Clear notifications" })).toBeNull();
});
