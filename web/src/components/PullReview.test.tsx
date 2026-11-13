// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { ChangedFile } from "../model.ts";
import { ActionsContext } from "./actions.tsx";
import { PullReview, usablePatch, wrapsByDefault } from "./PullReview.tsx";
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

test("filters the compact file tree without changing the selected diff", async () => {
  const initial = pull();
  render(
    <ActionsContext.Provider
      value={{
        files: async () => ({ files: [file, { ...file, path: "src/nested/folder/other.ts" }], truncated: false }),
      }}
    >
      <PullReview initial={initial} pulls={[initial]} onClose={() => {}} />
    </ActionsContext.Provider>,
  );
  await screen.findByRole("button", { name: /example.ts/ });
  expect(screen.getByText("nested/folder/")).toBeTruthy();
  const search = screen.getByRole("searchbox", { name: "Filter changed files" });
  fireEvent.input(search, { target: { value: "OTHER" } });
  expect(screen.queryByRole("button", { name: /example.ts/ })).toBeNull();
  expect(screen.getByRole("button", { name: /other.ts/ })).toBeTruthy();
  expect(screen.getByRole("region", { name: /Before code/ })).toBeTruthy();
  expect(screen.getByRole("region", { name: /After code/ })).toBeTruthy();
  expect(document.querySelector(".review-file-title")?.textContent).toContain("src/example.ts");
  fireEvent.input(search, { target: { value: "no matches" } });
  expect(screen.getByText("No matching files.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hide files" }));
  expect(screen.queryByRole("navigation", { name: "Changed files" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show files" }));
  expect(screen.getByRole("searchbox")).toBeTruthy();
});

test("wraps prose by default and leaves source code scrollable", () => {
  for (const path of ["README.md", "docs/guide.mdx", "docs/notes.txt", "docs/intro.rst", "LICENSE"])
    expect(wrapsByDefault(path)).toBe(true);
  for (const path of ["src/index.ts", "style.css", "config.yml", "README.test.ts"])
    expect(wrapsByDefault(path)).toBe(false);
});

test("uses per-file counts, retains wrap choices, and keeps positions independent of search", async () => {
  const initial = pull();
  const prose = {
    ...file,
    path: "README.md",
    additions: 2,
    deletions: 0,
    patch: "@@ -0,0 +1,2 @@\n+First line\n+Second line",
  };
  render(
    <ActionsContext.Provider value={{ files: async () => ({ files: [file, prose], truncated: false }) }}>
      <PullReview initial={initial} pulls={[initial]} onClose={() => {}} />
    </ActionsContext.Provider>,
  );
  await screen.findByRole("button", { name: /example.ts/ });
  expect(screen.getByRole("button", { name: /example.ts/ }).textContent).toContain("+1−1");
  expect(screen.getByRole("button", { name: /README.md/ }).textContent).toContain("+2−0");
  expect(screen.getByText("1 of 2 files")).toBeTruthy();
  const wrapButton = screen.getByRole("button", { name: "Wrap lines" });
  expect(wrapButton.getAttribute("aria-pressed")).toBe("false");
  await waitFor(() => expect(document.querySelector(".d2h-file-wrapper")).toBeTruthy());
  const diff = document.querySelector(".d2h-file-wrapper");
  fireEvent.click(wrapButton);
  await waitFor(() => expect(document.querySelector(".review-diff-wrap")).toBeTruthy());
  expect(document.querySelector(".d2h-file-wrapper")).toBe(diff);
  fireEvent.click(screen.getByRole("button", { name: "Next file" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Wrap lines" }).getAttribute("aria-pressed")).toBe("true"),
  );
  expect(screen.getByText("2 of 2 files")).toBeTruthy();
  expect(document.querySelector(".review-file-title")?.textContent).toContain("+2−0");
  expect(screen.getByRole("button", { name: "Next file" }).closest(".review-toolbar")).toBeTruthy();
  fireEvent.input(screen.getByRole("searchbox"), { target: { value: "README" } });
  expect(screen.getByText("2 of 2 files")).toBeTruthy();
  expect(document.querySelector(".review-tree-heading")?.textContent).toContain("2");
  fireEvent.keyDown(screen.getByRole("dialog"), { altKey: true, key: "ArrowUp" });
  await waitFor(() => expect(screen.getByText("1 of 2 files")).toBeTruthy());
  expect(screen.getByRole("button", { name: "Wrap lines" }).getAttribute("aria-pressed")).toBe("true");
});

test("turns auto-merge on and off from the review, like the board", async () => {
  const initial = pull();
  const setAutoMerge = vi.fn(async () => ({ merged: false }));
  const review = {
    read: async () => ({ pull: initial, description: "", canApprove: true, canMerge: true, reviews: [] }),
    approve: async () => {},
  };
  render(
    <ActionsContext.Provider
      value={{
        files: async () => ({ files: [file], truncated: false }),
        review,
        pulls: { setAutoMerge, merge: vi.fn(), updateBranch: vi.fn() },
      }}
    >
      <PullReview initial={initial} pulls={[initial]} onClose={() => {}} />
    </ActionsContext.Provider>,
  );
  const on = await screen.findByRole("button", { name: "Auto-merge" });
  await waitFor(() => expect((on as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(on);
  const off = await screen.findByRole("button", { name: "Cancel auto-merge" });
  expect(setAutoMerge).toHaveBeenLastCalledWith(initial, true);
  expect(document.querySelector(".review-metadata")?.textContent).toContain("Auto-merge");
  fireEvent.click(off);
  await screen.findByRole("button", { name: "Auto-merge" });
  expect(setAutoMerge).toHaveBeenLastCalledWith(expect.objectContaining({ autoMerge: true }), false);
});

test("says merged when turning auto-merge on merges at once", async () => {
  const initial = pull();
  render(
    <ActionsContext.Provider
      value={{
        files: async () => ({ files: [file], truncated: false }),
        review: {
          read: async () => ({ pull: initial, description: "", canApprove: true, canMerge: true, reviews: [] }),
          approve: async () => {},
        },
        pulls: { setAutoMerge: async () => ({ merged: true }), merge: vi.fn(), updateBranch: vi.fn() },
      }}
    >
      <PullReview initial={initial} pulls={[initial]} onClose={() => {}} />
    </ActionsContext.Provider>,
  );
  const on = await screen.findByRole("button", { name: "Auto-merge" });
  await waitFor(() => expect((on as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(on);
  expect((await screen.findByRole("status")).textContent).toBe("Merged");
});

test("offers no auto-merge for a draft", async () => {
  const initial = pull({ draft: true });
  render(
    <ActionsContext.Provider
      value={{
        files: async () => ({ files: [file], truncated: false }),
        pulls: { setAutoMerge: vi.fn(), merge: vi.fn(), updateBranch: vi.fn() },
      }}
    >
      <PullReview initial={initial} pulls={[initial]} onClose={() => {}} />
    </ActionsContext.Provider>,
  );
  await screen.findByRole("button", { name: /example.ts/ });
  expect(screen.queryByRole("button", { name: /auto-merge/i })).toBeNull();
});
