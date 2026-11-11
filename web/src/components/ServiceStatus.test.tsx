// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import { parseServiceSummary } from "../../../shared/status.ts";
import type { ServiceStatusState } from "../service_status.ts";
import { incidentFixture, summaryFixture } from "../service_status_fixtures.ts";
import { ServiceStatus } from "./ServiceStatus.tsx";

afterEach(cleanup);
function ready(): ServiceStatusState {
  return { data: parseServiceSummary(summaryFixture()), fetchedAt: Date.now(), loading: false, stale: false };
}
function show(state = ready(), open = true) {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  return { ...render(<ServiceStatus state={state} open={open} onOpen={onOpen} onClose={onClose} />), onOpen, onClose };
}
test("operational disclosure lists services and has an external source link", () => {
  const { onClose } = show();
  const dialog = screen.getByRole("dialog", { name: "GitHub Status" });
  expect(within(dialog).getByText("Actions")).toBeTruthy();
  expect(within(dialog).getByText("No active incidents.")).toBeTruthy();
  expect(within(dialog).getByRole("link", { name: "View on GitHub Status ↗" }).getAttribute("href")).toBe(
    "https://www.githubstatus.com/",
  );
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: /GitHub: Operational/ }));
});
test("incident details and updates come from the provided response", () => {
  const fixture = summaryFixture();
  fixture.components = [{ id: "actions", name: "Actions", status: "major_outage", showcase: true }];
  fixture.incidents = [
    {
      ...incidentFixture(),
      incident_updates: [
        ...incidentFixture().incident_updates,
        { id: "earlier", status: "investigating", body: "Earlier API update", display_at: "2026-11-11T11:00:00Z" },
      ],
    },
  ];
  show({ ...ready(), data: parseServiceSummary(fixture) });
  expect(screen.getByRole("button", { name: /GitHub: Major outage \(1\)/ })).toBeTruthy();
  expect(screen.getByText("API supplied update")).toBeTruthy();
  expect(screen.getByText("Earlier API update")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Test incident" })).toBeTruthy();
});
test("loading, unavailable and stale last success remain distinct", () => {
  const { rerender } = show({ loading: true, stale: true });
  expect(screen.getByRole("button", { name: /GitHub: Checking/ })).toBeTruthy();
  const props = { open: true, onOpen: vi.fn(), onClose: vi.fn() };
  rerender(<ServiceStatus state={{ loading: false, stale: true, error: "Can't refresh GitHub status." }} {...props} />);
  expect(screen.getByRole("button", { name: /GitHub: Unavailable/ })).toBeTruthy();
  expect(screen.queryByText("No active incidents.")).toBeNull();
  rerender(<ServiceStatus state={{ ...ready(), stale: true, error: "Can't refresh GitHub status." }} {...props} />);
  expect(screen.getByRole("button", { name: /Operational · Stale/ })).toBeTruthy();
  expect(screen.getByText(/Showing the last successful check/)).toBeTruthy();
  expect(screen.getByText(/Last successful check:/)).toBeTruthy();
});
test("outside pointer and tabbing away dismiss the popover", () => {
  const { onClose } = show();
  fireEvent.pointerDown(document.body);
  expect(onClose).toHaveBeenCalledOnce();
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  expect(onClose).toHaveBeenCalledTimes(2);
  outside.remove();
});
test("status pill and details expose maintenance in text", () => {
  const fixture = summaryFixture();
  fixture.scheduled_maintenances = [
    { ...incidentFixture(), status: "in_progress", scheduled_for: "2026-11-11T12:00:00Z" },
  ];
  show({ ...ready(), data: parseServiceSummary(fixture) });
  expect(screen.getByRole("button", { name: /GitHub: Maintenance/ })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Scheduled maintenance" })).toBeTruthy();
});
