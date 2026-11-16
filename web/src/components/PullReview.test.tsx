// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { ChangedFile } from "../model.ts";
import { ActionsContext } from "./actions.tsx";
import { PullReview, treeOrder, usablePatch, wrapsByDefault } from "./PullReview.tsx";
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
  expect(screen.getByText("nested/folder")).toBeTruthy();
  const search = screen.getByRole("searchbox", { name: "Filter changed files" });
  // The nested file is the tree's top file, so it is the one open; filtering it out leaves it open.
  fireEvent.input(search, { target: { value: "EXAMPLE" } });
  expect(screen.queryByRole("button", { name: /other.ts/ })).toBeNull();
  expect(screen.getByRole("button", { name: /example.ts/ })).toBeTruthy();
  expect(screen.getByRole("region", { name: /Before code/ })).toBeTruthy();
  expect(screen.getByRole("region", { name: /After code/ })).toBeTruthy();
  expect(document.querySelector(".review-file-title")?.textContent).toContain("src/nested/folder/other.ts");
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

test("turns auto-merge on and off from the review, like the board, closing it when turned on", async () => {
  const initial = pull();
  const close = vi.fn();
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
        pulls: { setAutoMerge, merge: vi.fn(), updateBranch: vi.fn(), requestRebase: vi.fn() },
      }}
    >
      <PullReview initial={initial} pulls={[initial]} onClose={close} />
    </ActionsContext.Provider>,
  );
  const on = await screen.findByRole("button", { name: "Auto-merge" });
  await waitFor(() => expect((on as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(on);
  const off = await screen.findByRole("button", { name: "Cancel auto-merge" });
  expect(setAutoMerge).toHaveBeenLastCalledWith(initial, true);
  expect(document.querySelector(".review-metadata")?.textContent).toContain("Auto-merge");
  expect(close).toHaveBeenCalledOnce();
  fireEvent.click(off);
  await screen.findByRole("button", { name: "Auto-merge" });
  expect(setAutoMerge).toHaveBeenLastCalledWith(expect.objectContaining({ autoMerge: true }), false);
  // Cancelling leaves the review open.
  expect(close).toHaveBeenCalledOnce();
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
        pulls: {
          setAutoMerge: async () => ({ merged: true }),
          merge: vi.fn(),
          updateBranch: vi.fn(),
          requestRebase: vi.fn(),
        },
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
        pulls: { setAutoMerge: vi.fn(), merge: vi.fn(), updateBranch: vi.fn(), requestRebase: vi.fn() },
      }}
    >
      <PullReview initial={initial} pulls={[initial]} onClose={() => {}} />
    </ActionsContext.Provider>,
  );
  await screen.findByRole("button", { name: /example.ts/ });
  expect(screen.queryByRole("button", { name: /auto-merge/i })).toBeNull();
});

test("draws code at the remembered text size and remembers a new choice", async () => {
  localStorage.setItem("github-dashboard:diff-font-size", "small");
  const initial = pull();
  render(
    <ActionsContext.Provider value={{ files: async () => ({ files: [file], truncated: false }) }}>
      <PullReview initial={initial} pulls={[initial]} onClose={() => {}} />
    </ActionsContext.Provider>,
  );
  const dialog = screen.getByRole("dialog");
  expect(dialog.dataset.diffFont).toBe("small");
  expect(screen.getByRole("button", { name: "Small text" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Large text" }));
  expect(dialog.dataset.diffFont).toBe("large");
  expect(localStorage.getItem("github-dashboard:diff-font-size")).toBe("large");
  localStorage.clear();
});

test("resizes the file tree from the divider, remembers the width and resets on a double click", async () => {
  localStorage.setItem("github-dashboard:review-tree-width", "300");
  const initial = pull();
  render(
    <ActionsContext.Provider value={{ files: async () => ({ files: [file], truncated: false }) }}>
      <PullReview initial={initial} pulls={[initial]} onClose={() => {}} />
    </ActionsContext.Provider>,
  );
  const body = document.querySelector<HTMLElement>(".review-body");
  const divider = screen.getByRole("separator", { name: "Resize changed files" });
  expect(body?.style.getPropertyValue("--tree-width")).toBe("300px");
  expect(divider.getAttribute("aria-valuenow")).toBe("300");
  // Nothing has a size here, so any width comes out as the narrowest the tree may be.
  fireEvent.keyDown(divider, { key: "ArrowRight" });
  expect(body?.style.getPropertyValue("--tree-width")).toBe("180px");
  expect(localStorage.getItem("github-dashboard:review-tree-width")).toBe("180");
  fireEvent.dblClick(divider);
  expect(body?.style.getPropertyValue("--tree-width")).toBe("");
  expect(localStorage.getItem("github-dashboard:review-tree-width")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Hide files" }));
  expect(screen.queryByRole("separator", { name: "Resize changed files" })).toBeNull();
});

test("resizes the two sides of a split diff, remembers the share and resets on a double click", async () => {
  localStorage.setItem("github-dashboard:review-split", "0.6");
  const initial = pull();
  render(
    <ActionsContext.Provider value={{ files: async () => ({ files: [file], truncated: false }) }}>
      <PullReview initial={initial} pulls={[initial]} onClose={() => {}} />
    </ActionsContext.Provider>,
  );
  const divider = await screen.findByRole("separator", { name: "Resize before and after" });
  const code = document.querySelector<HTMLElement>(".review-code");
  expect(code?.style.getPropertyValue("--split")).toBe("60%");
  expect(divider.getAttribute("aria-valuenow")).toBe("60");
  fireEvent.keyDown(divider, { key: "ArrowLeft" });
  expect(code?.style.getPropertyValue("--split")).toBe("58%");
  expect(localStorage.getItem("github-dashboard:review-split")).toBe("0.58");
  fireEvent.keyDown(divider, { key: "Home" });
  expect(localStorage.getItem("github-dashboard:review-split")).toBe("0.15");
  fireEvent.dblClick(divider);
  expect(code?.style.getPropertyValue("--split")).toBe("");
  expect(localStorage.getItem("github-dashboard:review-split")).toBeNull();
  // A unified diff has no sides to resize.
  fireEvent.click(screen.getByRole("button", { name: "Unified" }));
  expect(screen.queryByRole("separator", { name: "Resize before and after" })).toBeNull();
  localStorage.clear();
});

test("orders files as the tree shows them, folders first, so the top file opens first", async () => {
  const paths = ["README.md", "web/b.ts", "src/x.ts", "web/a/c.ts", "package.json"];
  const files = paths.map((path) => ({ ...file, path }));
  expect(treeOrder(files).map((item) => item.path)).toEqual([
    "web/a/c.ts",
    "web/b.ts",
    "src/x.ts",
    "README.md",
    "package.json",
  ]);
  const initial = pull();
  render(
    <ActionsContext.Provider value={{ files: async () => ({ files, truncated: false }) }}>
      <PullReview initial={initial} pulls={[initial]} onClose={() => {}} />
    </ActionsContext.Provider>,
  );
  await screen.findByText("1 of 5 files");
  expect(document.querySelector('.review-tree [aria-current="true"]')?.getAttribute("title")).toBe("web/a/c.ts");
  fireEvent.click(screen.getByRole("button", { name: "Next file" }));
  expect(document.querySelector('.review-tree [aria-current="true"]')?.getAttribute("title")).toBe("web/b.ts");
});

test("shows PR information in a popup that Escape closes without closing the review", async () => {
  const close = vi.fn();
  const initial = pull({ title: "Add the thing" });
  render(
    <ActionsContext.Provider
      value={{
        files: async () => ({ files: [file], truncated: false }),
        review: {
          read: async () => ({
            pull: initial,
            description: "Why this change is needed.",
            canApprove: true,
            canMerge: true,
            reviews: [{ user: { login: "octocat" }, state: "APPROVED", body: "" }],
          }),
          approve: async () => {},
        },
      }}
    >
      <PullReview initial={initial} pulls={[initial]} onClose={close} />
    </ActionsContext.Provider>,
  );
  await screen.findByRole("button", { name: /example.ts/ });
  expect(document.querySelector(".pull-info")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "PR info" }));
  const popup = document.querySelector<HTMLDialogElement>(".pull-info");
  await waitFor(() => expect(popup?.textContent).toContain("Why this change is needed."));
  expect(popup?.textContent).toContain("octocat");
  expect(popup?.textContent).toContain("approved");
  fireEvent(popup as HTMLDialogElement, new Event("cancel", { cancelable: true }));
  expect(document.querySelector(".pull-info")).toBeNull();
  expect(close).not.toHaveBeenCalled();
});

test("shows a changed image before beside after, and an added one with no before", async () => {
  const png: ChangedFile = {
    path: "docs/chart.png",
    previousPath: undefined,
    status: "modified",
    additions: 0,
    deletions: 0,
  };
  const icon: ChangedFile = { ...png, path: "icons/new.png", status: "added" };
  const image = vi.fn(async (_pull, changed: ChangedFile, side: string) => ({
    url: `data:image/png;base64,${btoa(`${changed.path}:${side}`)}`,
    bytes: 2048,
  }));
  const { container } = render(
    <ActionsContext.Provider value={{ files: async () => ({ files: [png, icon], truncated: false }), image }}>
      <PullReview initial={pull()} pulls={[pull()]} onClose={() => {}} />
    </ActionsContext.Provider>,
  );
  await waitFor(() => expect(container.querySelectorAll(".review-image-frame img")).toHaveLength(2));
  expect(screen.getByRole("figure", { name: "Before image" }).textContent).toContain("2.0 KB");
  expect(container.querySelector(".review-images-split")).not.toBeNull();
  expect(container.querySelector(".review-split-divider")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Wrap lines" })).toHaveProperty("disabled", true);

  fireEvent.click(screen.getByRole("button", { name: "Next file" }));
  await waitFor(() => expect(container.querySelectorAll(".review-image-frame img")).toHaveLength(1));
  expect(screen.getByRole("figure", { name: "Before image" }).textContent).toContain("adds it");
  expect(image).not.toHaveBeenCalledWith(expect.anything(), icon, "before");

  fireEvent.click(screen.getByRole("button", { name: "Unified" }));
  await waitFor(() => expect(container.querySelector(".review-images-unified")).not.toBeNull());
  expect(screen.getByText("+ After")).not.toBeNull();
});

test("says a binary file that isn't an image changed, with a link to GitHub", async () => {
  const binary: ChangedFile = {
    path: "data/model.bin",
    previousPath: undefined,
    status: "modified",
    additions: 0,
    deletions: 0,
  };
  render(
    <ActionsContext.Provider value={{ files: async () => ({ files: [binary], truncated: false }), image: vi.fn() }}>
      <PullReview initial={pull()} pulls={[pull()]} onClose={() => {}} />
    </ActionsContext.Provider>,
  );
  await screen.findByText("Binary file changed.");
  expect(screen.getByRole("link", { name: /files on GitHub/ }).getAttribute("href")).toBe(
    "https://github.com/octocat/weather-station/pull/1/files",
  );
});

test("shows an SVG as a picture, with its code a click away", async () => {
  const svg: ChangedFile = { ...file, path: "icons/logo.svg", patch: "@@ -1 +1 @@\n-<svg/>\n+<svg></svg>" };
  const image = vi.fn(async () => ({ url: "data:image/svg+xml;base64,PHN2Zy8+", bytes: 6 }));
  const { container } = render(
    <ActionsContext.Provider value={{ files: async () => ({ files: [svg], truncated: false }), image }}>
      <PullReview initial={pull()} pulls={[pull()]} onClose={() => {}} />
    </ActionsContext.Provider>,
  );
  await waitFor(() => expect(container.querySelectorAll(".review-image-frame img")).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "Show code" }));
  await waitFor(() => expect(container.querySelector(".review-images")).toBeNull());
  expect(screen.getByRole("button", { name: "Show code" }).getAttribute("aria-pressed")).toBe("true");
});
