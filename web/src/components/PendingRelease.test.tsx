// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { PullActions, PullRequest } from "../model.ts";
import { ActionsContext } from "./actions.tsx";
import { PendingProvider, ReleaseAfterMerge } from "./PendingRelease.tsx";
import { fakeRunActions, project, pull } from "./testing.ts";

afterEach(cleanup);

const APP = project();
const own = pull({ number: 7, title: "Own change" });
const lib = pull({ repo: "octocat/lib", number: 2, title: "Library change" });

function setUp(merged: (pull: Pick<PullRequest, "repo" | "number">) => Promise<boolean>) {
  const runs = fakeRunActions();
  const pulls = { merged: vi.fn(merged) } as unknown as PullActions;
  const view = (open: PullRequest[]) => (
    <ActionsContext.Provider value={{ runs, pulls }}>
      <PendingProvider pulls={open}>
        <ReleaseAfterMerge project={APP} />
      </PendingProvider>
    </ActionsContext.Provider>
  );
  const { rerender } = render(view([own, lib]));
  fireEvent.click(screen.getByRole("button", { name: "Release after merge…" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /#7 Own change/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /#2 Library change/ }));
  fireEvent.click(screen.getByRole("button", { name: "Release after 2 merge" }));
  return { runs, pulls, show: (open: PullRequest[]) => rerender(view(open)) };
}

test("the release waits for every pull request picked, then releases the next minor", async () => {
  const { runs, show } = setUp(async () => true);
  expect(screen.getByText("Releases once #7, lib#2 merge (0 of 2 merged)")).toBeTruthy();

  show([lib]);
  await waitFor(() => expect(screen.getByText("Releases once #7, lib#2 merge (1 of 2 merged)")).toBeTruthy());
  expect(runs.release).not.toHaveBeenCalled();

  show([]);
  await waitFor(() => expect(runs.release).toHaveBeenCalledWith(APP, "v1.3.0"));
  expect((await screen.findByRole("status")).textContent).toBe("Released v1.3.0.");
});

test("one that closed without merging cancels the release", async () => {
  const { runs, show } = setUp(async (one) => one.number !== 2);
  show([own]);
  expect((await screen.findByRole("status")).textContent).toBe(
    "lib#2 closed without merging, so nothing was released.",
  );
  show([]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(runs.release).not.toHaveBeenCalled();
});

test("Cancel stops it waiting", () => {
  const { pulls, show } = setUp(async () => true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel the release of weather-station after merge" }));
  show([]);
  expect(pulls.merged).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Release after merge…" })).toBeTruthy();
});
