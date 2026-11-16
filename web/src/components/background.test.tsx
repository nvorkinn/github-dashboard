// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { PullRequest } from "../model.ts";
import { ActionsContext } from "./actions.tsx";
import { BackgroundProvider } from "./background.tsx";
import { PullRow } from "./PullList.tsx";
import { NOW, pull } from "./testing.ts";

afterEach(cleanup);

/** A promise and the means to settle it, for a call that is under way until the test says. */
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setUp(shown: PullRequest = pull()) {
  const merging = pending<void>();
  const turningOn = pending<{ merged: boolean }>();
  const pulls = {
    setAutoMerge: vi.fn((_pull: PullRequest, _enabled: boolean) => turningOn.promise),
    merge: vi.fn((_pull: PullRequest) => merging.promise),
    updateBranch: vi.fn(async (_pull: PullRequest) => {}),
  };
  const review = {
    read: vi.fn(async () => ({ pull: shown, description: "", canApprove: true, canMerge: true, reviews: [] })),
    approve: async () => {},
  };
  render(
    <ActionsContext.Provider value={{ files: async () => ({ files: [], truncated: false }), review, pulls }}>
      <BackgroundProvider>
        <ul>
          <PullRow pull={shown} now={NOW} />
        </ul>
      </BackgroundProvider>
    </ActionsContext.Provider>,
  );
  return { pulls, merging, turningOn };
}

async function openReview() {
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  const dialog = await screen.findByRole("dialog");
  return within(dialog);
}

async function enabled(find: Promise<HTMLElement>) {
  const button = await find;
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  return button;
}

test("closes the review as soon as a merge is confirmed, and says on the page how it went", async () => {
  const { pulls, merging } = setUp();
  const review = await openReview();
  fireEvent.click(await enabled(review.findByRole("button", { name: "Merge" })));
  fireEvent.click(review.getByRole("button", { name: "Confirm merge" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(await screen.findByText("Merging #1 in weather-station…")).toBeTruthy();
  expect(document.querySelector(".pull-badges")?.textContent).toContain("Merging");
  await waitFor(() => expect(pulls.merge).toHaveBeenCalledOnce());
  merging.resolve();
  expect(await screen.findByText("Merged #1 in weather-station")).toBeTruthy();
  expect(document.querySelector(".pull-badges")?.textContent).toContain("Merged");
});

test("shows a merge that failed after the review closed, until dismissed", async () => {
  const { pulls, merging } = setUp();
  const review = await openReview();
  fireEvent.click(await enabled(review.findByRole("button", { name: "Merge" })));
  fireEvent.click(review.getByRole("button", { name: "Confirm merge" }));
  await waitFor(() => expect(pulls.merge).toHaveBeenCalledOnce());
  merging.reject(new Error("Base branch was modified."));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Couldn't merge #1 in weather-station: Base branch was modified.");
  // The card says so too, and offers its buttons again.
  expect(document.querySelector(".action-problem")?.textContent).toBe("Merge failed: Base branch was modified.");
  expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy();
  fireEvent.click(within(alert).getByRole("button", { name: /^Dismiss/ }));
  expect(document.querySelector(".background-notice")).toBeNull();
  expect(document.querySelector(".action-problem")).toBeNull();
});

test("closes the review as soon as auto-merge is clicked, and shows it on at once", async () => {
  const { pulls, turningOn } = setUp();
  const review = await openReview();
  fireEvent.click(await enabled(review.findByRole("button", { name: "Auto-merge" })));
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(pulls.setAutoMerge).toHaveBeenCalledWith(expect.objectContaining({ number: 1 }), true));
  expect(await screen.findByText("Turning on auto-merge for #1 in weather-station…")).toBeTruthy();
  expect(document.querySelector(".pull-badges")?.textContent).toContain("Auto-merge");
  turningOn.reject(new Error("Auto-merge is not allowed for this repository."));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't turn on auto-merge for #1 in weather-station: Auto-merge is not allowed for this repository.",
  );
  expect(document.querySelector(".pull-badges")?.textContent).not.toContain("Auto-merge");
});

test("an action on the card replaces what the review left", async () => {
  const { pulls, turningOn } = setUp();
  const review = await openReview();
  fireEvent.click(await enabled(review.findByRole("button", { name: "Auto-merge" })));
  turningOn.resolve({ merged: false });
  const cancel = await screen.findByRole("button", { name: "Cancel auto-merge" });
  pulls.setAutoMerge.mockImplementation(async () => ({ merged: false }));
  fireEvent.click(cancel);
  await screen.findByRole("button", { name: "Auto-merge" });
  expect(document.querySelector(".pull-badges")?.textContent).not.toContain("Auto-merge");
});
