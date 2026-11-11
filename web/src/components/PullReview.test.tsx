// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { ChangedFile } from "../model.ts";
import { ActionsContext } from "./actions.tsx";
import { PullReview, usablePatch } from "./PullReview.tsx";
import { pull } from "./testing.ts";

afterEach(cleanup);
const file: ChangedFile = {
  path: "src/example.ts",
  previousPath: undefined,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-const old = 1;\n+const value = 2;",
};
test("requires complete hunk counts and file change counts", () => {
  expect(usablePatch(file)).toBe(true);
  expect(usablePatch({ ...file, patch: "@@ -1,3 +1,3 @@\n-x\n+y" })).toBe(false);
  expect(usablePatch({ ...file, additions: 2 })).toBe(false);
  const { patch: _patch, ...missing } = file;
  expect(usablePatch(missing)).toBe(false);
  expect(usablePatch({ ...file, patch: "@@ -0,0 +1 @@\n+hello", deletions: 0 })).toBe(true);
});
test("renders one split diff, navigates files, toggles unified and handles Escape", async () => {
  const close = vi.fn();
  const initial = pull();
  render(
    <ActionsContext.Provider
      value={{ files: async () => ({ files: [file, { ...file, path: "other.ts", patch: "" }], truncated: true }) }}
    >
      <PullReview initial={initial} pulls={[initial]} onClose={close} />
    </ActionsContext.Provider>,
  );
  await waitFor(() => expect(document.querySelectorAll(".d2h-file-wrapper")).toHaveLength(1));
  expect(document.querySelector(".d2h-file-side-diff")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Unified" }));
  await waitFor(() => expect(document.querySelector(".d2h-file-side-diff")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Next file" }));
  await screen.findByText(/Preview unavailable/);
  expect(document.querySelector(".d2h-file-wrapper")).toBeNull();
  expect(screen.getByText(/Only the first 300/)).toBeTruthy();
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(close).toHaveBeenCalledOnce();
});
test("does not let a late file response replace the next PR", async () => {
  let release!: (value: { files: ChangedFile[]; truncated: boolean }) => void;
  const first = pull();
  const second = pull({ number: 2, title: "Second" });
  render(
    <ActionsContext.Provider
      value={{
        files: (p) =>
          p.number === 1
            ? new Promise((resolve) => {
                release = resolve;
              })
            : Promise.resolve({ files: [{ ...file, path: "second.ts" }], truncated: false }),
      }}
    >
      <PullReview initial={first} pulls={[first, second]} onClose={() => {}} />
    </ActionsContext.Provider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Next PR" }));
  await screen.findByRole("button", { name: /second.ts/ });
  release({ files: [file], truncated: false });
  await waitFor(() => expect(screen.queryByRole("button", { name: /example.ts/ })).toBeNull());
});
