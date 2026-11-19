// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { PendingActions, PendingRelease, Project, PullRequest } from "../model.ts";
import { ActionsContext } from "./actions.tsx";
import { PendingBadges, PendingButton, PendingContext, PendingStatus, pendingOf } from "./PendingRelease.tsx";
import { project, pull } from "./testing.ts";

afterEach(cleanup);

const APP = project();
const LIB = project({ repo: "octocat/lib", name: "lib" });

function waiting(fields: Partial<PendingRelease> = {}): PendingRelease {
  return {
    id: "one",
    repo: APP.repo,
    pulls: [
      { repo: APP.repo, number: 1, title: "Own change", merged: { at: "2026-11-19T10:00:00Z" } },
      { repo: LIB.repo, number: 2, title: "Library change" },
    ],
    by: "octocat",
    createdAt: "2026-11-19T09:00:00Z",
    state: "waiting",
    ...fields,
  };
}

function fakePending(): PendingActions & { set: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } {
  return { set: vi.fn(() => Promise.resolve()), cancel: vi.fn(() => Promise.resolve()) };
}

function show(
  node: preact.ComponentChildren,
  pending: PendingRelease[] | undefined,
  pulls: PullRequest[] = [],
  actions = fakePending(),
  projects: Project[] = [APP, LIB],
) {
  render(
    <ActionsContext.Provider value={{ pending: actions }}>
      <PendingContext.Provider value={{ pending, pulls, projects }}>{node}</PendingContext.Provider>
    </ActionsContext.Provider>,
  );
  return actions;
}

test("a waiting release says what it waits for and how far that got, and can be cancelled", async () => {
  const actions = show(<PendingStatus project={APP} />, [waiting()]);
  expect(screen.getByText(/Next minor release once all 2 merge \(1 merged\)/)).toBeTruthy();
  expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "#1 Own change (merged)",
    "lib#2 Library change",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Cancel the pending release of weather-station" }));
  await waitFor(() => expect(actions.cancel).toHaveBeenCalledWith(expect.objectContaining({ id: "one" })));
});

test("one that ended says how, and is dismissed rather than cancelled", () => {
  show(<PendingStatus project={APP} />, [
    waiting({
      state: "released",
      tag: "v1.3.0",
      url: "https://github.com/octocat/weather-station/releases/tag/v1.3.0",
      endedAt: "2026-11-19T11:00:00Z",
    }),
  ]);
  expect(screen.getByRole("link", { name: "v1.3.0" }).getAttribute("href")).toBe(
    "https://github.com/octocat/weather-station/releases/tag/v1.3.0",
  );
  expect(screen.getByRole("button", { name: "Dismiss the pending release of weather-station" })).toBeTruthy();
});

test("the one shown is the one that waits, else the last to end", () => {
  const old = waiting({ id: "a", state: "cancelled", endedAt: "2026-11-19T08:00:00Z" });
  const newer = waiting({ id: "b", state: "failed", endedAt: "2026-11-19T09:00:00Z" });
  expect(pendingOf([old, newer], APP.repo)?.id).toBe("b");
  expect(pendingOf([old, waiting({ id: "c" }), newer], APP.repo)?.id).toBe("c");
  expect(pendingOf([old], LIB.repo)).toBeUndefined();
});

test("the picker offers every shown pull request, the project's own first, and sets up the release", async () => {
  const pulls = [
    pull({ repo: LIB.repo, number: 2, title: "Library change" }),
    pull({ repo: APP.repo, number: 7, title: "Own change", autoMerge: true }),
  ];
  const actions = show(<PendingButton project={APP} />, [], pulls);
  fireEvent.click(screen.getByRole("button", { name: "Release after merge…" }));
  const dialog = screen.getByRole("dialog");
  const groups = within(dialog)
    .getAllByRole("group")
    .map((group) => group.querySelector("legend")?.textContent);
  expect(groups).toEqual(["weather-station · this project", "lib"]);
  expect(within(dialog).getByRole("button", { name: "Pick pull requests" }).hasAttribute("disabled")).toBe(true);

  fireEvent.click(within(dialog).getByRole("checkbox", { name: /#7 Own change/ }));
  fireEvent.click(within(dialog).getByRole("checkbox", { name: /#2 Library change/ }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Release after all 2 merge" }));
  await waitFor(() =>
    expect(actions.set).toHaveBeenCalledWith(APP, [
      { repo: APP.repo, number: 7 },
      { repo: LIB.repo, number: 2 },
    ]),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("changing what it waits for starts from what it waits for now, and says why the relay refused", async () => {
  const pulls = [pull({ repo: LIB.repo, number: 2, title: "Library change" })];
  const actions = fakePending();
  actions.set.mockRejectedValueOnce(new Error("lib#2 isn't open any more."));
  show(<PendingButton project={APP} />, [waiting()], pulls, actions);
  fireEvent.click(screen.getByRole("button", { name: "Change PRs…" }));
  const box = screen.getByRole("checkbox", { name: /#2 Library change/ }) as HTMLInputElement;
  expect(box.checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Release after it merges" }));
  expect((await screen.findByRole("alert")).textContent).toBe("lib#2 isn't open any more.");
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("nothing is offered where the relay keeps no pending releases", () => {
  show(<PendingButton project={APP} />, undefined);
  expect(screen.queryByRole("button")).toBeNull();
});

test("a pull request a release waits for says which project it releases", () => {
  show(<PendingBadges pull={pull({ repo: LIB.repo, number: 2 })} />, [waiting()]);
  const badge = screen.getByText("Releases weather-station");
  expect(badge.getAttribute("title")).toBe("Merging it releases octocat/weather-station");
});
