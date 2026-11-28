import { Diff2HtmlUI } from "diff2html/lib/ui/js/diff2html-ui-slim.js";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { DIFF_FONT_SIZES, type DiffFontSize, rememberDiffFontSize, rememberedDiffFontSize } from "../diff_font.ts";
import { imageType } from "../github/images.ts";
import type { ReviewInfo } from "../github/review.ts";
import type { ChangedFile, PullFiles, PullRequest } from "../model.ts";
import { isDependabot, summarize } from "../model.ts";
import { clampSplitShare, rememberedSplitShare, rememberSplitShare } from "../split_share.ts";
import { clampTreeWidth, MIN_TREE_WIDTH, rememberedTreeWidth, rememberTreeWidth } from "../tree_width.ts";
import { AutoMergeButton, ConfirmButton, reasonOf, useAction, useActions } from "./actions.tsx";
import { useBackground } from "./background.tsx";
import { ExternalLink } from "./ExternalLink.tsx";
import { fileIcon, folderIcon } from "./file_icons.ts";
import { Icon } from "./Icon.tsx";
import { BinaryNote, ImageDiff, isBinary } from "./ImageDiff.tsx";
import { PullInfo } from "./PullInfo.tsx";
import { ReviewChecks, withWorkflows } from "./ReviewChecks.tsx";
import "diff2html/bundles/css/diff2html.min.css";

import "./PullReview.css";

/** GitHub may omit patches or cut them short. Never present an incomplete patch as a full review. */
export function usablePatch(file: ChangedFile): boolean {
  if (!file.patch || file.patch.length > 200_000) return false;
  let added = 0;
  let removed = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let hunks = 0;
  for (const line of file.patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (oldLeft || newLeft) return false;
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
      hunks++;
    } else if (line.startsWith("+")) {
      added++;
      newLeft--;
    } else if (line.startsWith("-")) {
      removed++;
      oldLeft--;
    } else if (line.startsWith(" ")) {
      oldLeft--;
      newLeft--;
    } else if (line && !line.startsWith("\\")) return false;
    if (oldLeft < 0 || newLeft < 0) return false;
  }
  return hunks > 0 && oldLeft === 0 && newLeft === 0 && added === file.additions && removed === file.deletions;
}

/** Prose benefits from wrapping; source files retain their original line layout. */
export function wrapsByDefault(path: string): boolean {
  return (
    /\.(md|mdx|markdown|txt|text|rst|adoc|asciidoc|org|tex|wiki)$/i.test(path) ||
    /(?:^|\/)(README|CHANGELOG|CHANGES|LICENSE|COPYING|AUTHORS|NEWS)$/i.test(path)
  );
}

function FileDiff({
  file,
  split,
  wrap,
  fontSize,
}: {
  file: ChangedFile;
  split: boolean;
  wrap: boolean;
  fontSize: DiffFontSize;
}) {
  const target = useRef<HTMLDivElement>(null);
  const usable = usablePatch(file);
  useEffect(() => {
    if (!target.current || !usable) return;
    // Quoted paths keep unusual filenames from becoming extra diff headers.
    const oldPath = JSON.stringify(`a/${file.previousPath ?? file.path}`);
    const newPath = JSON.stringify(`b/${file.path}`);
    const ui = new Diff2HtmlUI(
      target.current,
      `diff --git ${oldPath} ${newPath}\n--- ${oldPath}\n+++ ${newPath}\n${file.patch}\n`,
      {
        drawFileList: false,
        outputFormat: split ? "side-by-side" : "line-by-line",
        matching: "none",
        highlight: true,
        fileContentToggle: false,
        synchronisedScroll: true,
        renderNothingWhenEmpty: false,
      },
    );
    ui.draw();
    const element = target.current;
    return () => element.replaceChildren();
  }, [file, split, usable]);
  useEffect(() => {
    if (!target.current || !usable) return;
    const element = target.current;
    // Separate tables need equal row heights when a line wraps on only one side.
    // Measure natural heights first so resizing can shrink as well as grow a pair.
    const alignRows = () => {
      const panes = element.querySelectorAll(".d2h-file-side-diff");
      const before = [...(panes[0]?.querySelectorAll("tr") ?? [])];
      const after = [...(panes[1]?.querySelectorAll("tr") ?? [])];
      for (const row of [...before, ...after]) row.style.height = "";
      if (!split || !wrap) return;
      const heights = before.map((row, i) =>
        Math.max(row.getBoundingClientRect().height, after[i]?.getBoundingClientRect().height ?? 0),
      );
      before.forEach((row, i) => {
        const height = `${heights[i]}px`;
        row.style.height = height;
        if (after[i]) after[i].style.height = height;
      });
    };
    alignRows();
    const panes = [...element.querySelectorAll<HTMLElement>(".d2h-file-side-diff")];
    const widths = () => [element.clientWidth, ...panes.map((pane) => pane.clientWidth)].join(":");
    let width = widths();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            if (widths() === width) return;
            width = widths();
            alignRows();
          });
    observer?.observe(element);
    for (const pane of panes) observer?.observe(pane);
    target.current.querySelectorAll<HTMLElement>(".d2h-file-side-diff, .d2h-file-diff").forEach((pane, index) => {
      pane.tabIndex = 0;
      pane.setAttribute("role", "region");
      pane.setAttribute(
        "aria-label",
        split
          ? `${index === 0 ? "Before" : "After"} code${wrap ? ", wrapped lines" : ", scroll horizontally for long lines"}`
          : `Unified code${wrap ? ", wrapped lines" : ", scroll horizontally for long lines"}`,
      );
    });
    return () => observer?.disconnect();
    // The font size changes how lines wrap, so the rows are measured again.
  }, [file, split, usable, wrap, fontSize]);
  return usable ? (
    <div ref={target} class={`review-diff ${wrap ? "review-diff-wrap" : ""}`} />
  ) : (
    <p class="empty">
      Preview unavailable: this patch is missing, incomplete, binary, or too large. Open on GitHub to review it.
    </p>
  );
}

/** A folder's open or closed state, larger than a text arrow so that folders read apart from files. */
function Chevron() {
  return (
    <svg class="review-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}

/** The files in the order the tree shows them: each folder's files (folders first, by first appearance), then the
    files beside them. The tree's top file opens first, and Previous and Next walk the tree from top to bottom. */
export function treeOrder(files: ChangedFile[], prefix = ""): ChangedFile[] {
  const folders = new Map<string, ChangedFile[]>();
  const leaves: ChangedFile[] = [];
  for (const file of files) {
    const relative = file.path.slice(prefix.length);
    const slash = relative.indexOf("/");
    if (slash < 0) leaves.push(file);
    else {
      const folder = relative.slice(0, slash + 1);
      folders.set(folder, [...(folders.get(folder) ?? []), file]);
    }
  }
  return [...[...folders].flatMap(([folder, group]) => treeOrder(group, `${prefix}${folder}`)), ...leaves];
}

function FileTree({
  files,
  selected,
  choose,
  prefix = "",
}: {
  files: ChangedFile[];
  selected: string | undefined;
  choose: (path: string) => void;
  prefix?: string;
}) {
  const folders = new Map<string, ChangedFile[]>();
  const leaves: ChangedFile[] = [];
  for (const file of files) {
    const relative = file.path.slice(prefix.length);
    const slash = relative.indexOf("/");
    if (slash < 0) leaves.push(file);
    else {
      const folder = relative.slice(0, slash + 1);
      const group = folders.get(folder) ?? [];
      group.push(file);
      folders.set(folder, group);
    }
  }
  return (
    <>
      {[...folders].map(([initialFolder, group]) => {
        let folder = initialFolder;
        // Compact single-child directory chains without hiding the top-level grouping.
        if (prefix) {
          while (true) {
            const next = group[0]?.path.slice(prefix.length + folder.length).split("/");
            if (
              !next ||
              next.length < 2 ||
              !group.every((file) => file.path.startsWith(`${prefix}${folder}${next[0]}/`))
            )
              break;
            folder += `${next[0]}/`;
          }
        }
        const name = folder.slice(0, -1);
        return (
          <details key={folder} open>
            <summary title={`${prefix}${name}`}>
              <Chevron />
              <img class="review-file-icon review-folder-closed" src={folderIcon(name, false)} alt="" />
              <img class="review-file-icon review-folder-open" src={folderIcon(name, true)} alt="" />
              <span class="review-folder-name">{name}</span>
              <span class="review-count">{group.length}</span>
            </summary>
            <div class="review-folder">
              <FileTree files={group} selected={selected} choose={choose} prefix={`${prefix}${folder}`} />
            </div>
          </details>
        );
      })}
      {leaves.map((file) => (
        <button
          type="button"
          key={file.path}
          class={`review-file review-status-${file.status}`}
          aria-current={file.path === selected ? "true" : undefined}
          title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
          onClick={() => choose(file.path)}
        >
          <span class="review-chevron-space" />
          <img class="review-file-icon" src={fileIcon(file.path)} alt="" />
          <span class="review-filename">{file.path.slice(prefix.length)}</span>
          <span
            class="review-stats"
            role="img"
            aria-label={`${file.status}, ${file.additions} additions, ${file.deletions} deletions`}
          >
            <span>+{file.additions}</span>
            <span>−{file.deletions}</span>
          </span>
        </button>
      ))}
    </>
  );
}

/** The gap between the file tree and the diff. Drag it, or focus it and use the arrow keys, to resize the tree. */
function TreeDivider({
  width,
  setWidth,
}: {
  width: number | undefined;
  setWidth: (width: number | undefined) => void;
}) {
  const drag = useRef<{ x: number; from: number; to: number } | undefined>(undefined);
  const drawn = (divider: HTMLElement) => divider.previousElementSibling?.getBoundingClientRect().width ?? 0;
  const choose = (divider: HTMLElement, wanted: number) => {
    const chosen = clampTreeWidth(wanted, divider.parentElement?.clientWidth ?? 0);
    setWidth(chosen);
    return chosen;
  };
  const finish = () => {
    if (drag.current && drag.current.to !== drag.current.from) rememberTreeWidth(drag.current.to);
    drag.current = undefined;
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> can't be focused or dragged; this is the ARIA window splitter.
    <div
      class="review-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize changed files"
      aria-valuenow={width}
      aria-valuemin={MIN_TREE_WIDTH}
      aria-valuetext={width === undefined ? "Default width" : `${width} pixels`}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const from = drawn(event.currentTarget);
        drag.current = { x: event.clientX, from, to: from };
      }}
      onPointerMove={(event) => {
        const moved = drag.current && event.clientX - drag.current.x;
        // A click that never moves leaves the tree at the width the stylesheet gives it.
        if (drag.current && moved) drag.current.to = choose(event.currentTarget, drag.current.from + moved);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDblClick={() => {
        setWidth(undefined);
        rememberTreeWidth(undefined);
      }}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const from = drawn(event.currentTarget);
        const wanted = { ArrowLeft: from - 16, ArrowRight: from + 16, Home: 0, End: Number.MAX_SAFE_INTEGER }[
          event.key
        ];
        if (wanted === undefined) return;
        event.preventDefault();
        rememberTreeWidth(choose(event.currentTarget, wanted));
      }}
    />
  );
}

/** The line between the two sides of a split diff. Drag it, or focus it and use the arrow keys, to give one side more room. */
function SplitDivider({
  share,
  setShare,
}: {
  share: number | undefined;
  setShare: (share: number | undefined) => void;
}) {
  const dragging = useRef(false);
  const chosen = useRef<number | undefined>(undefined);
  const choose = (divider: HTMLElement, clientX: number) => {
    const area = divider.parentElement?.getBoundingClientRect();
    if (!area?.width) return;
    chosen.current = clampSplitShare((clientX - area.left) / area.width);
    setShare(chosen.current);
  };
  const finish = () => {
    if (dragging.current && chosen.current !== undefined) rememberSplitShare(chosen.current);
    dragging.current = false;
    chosen.current = undefined;
  };
  const percent = Math.round((share ?? 0.5) * 100);
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> can't be focused or dragged; this is the ARIA window splitter.
    <div
      class="review-split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize before and after"
      aria-valuenow={percent}
      aria-valuemin={15}
      aria-valuemax={85}
      aria-valuetext={`Before takes ${percent} percent`}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        dragging.current = true;
      }}
      onPointerMove={(event) => {
        if (dragging.current) choose(event.currentTarget, event.clientX);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDblClick={() => {
        setShare(undefined);
        rememberSplitShare(undefined);
      }}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const from = share ?? 0.5;
        const wanted = { ArrowLeft: from - 0.02, ArrowRight: from + 0.02, Home: 0, End: 1 }[event.key];
        if (wanted === undefined) return;
        event.preventDefault();
        const next = clampSplitShare(wanted);
        setShare(next);
        rememberSplitShare(next);
      }}
    />
  );
}

export function PullReview({
  initial,
  pulls,
  onClose,
}: {
  initial: PullRequest;
  pulls: PullRequest[];
  onClose: () => void;
}) {
  const actions = useActions();
  const background = useBackground();
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, select] = useState(initial);
  const current = pulls.find((p) => p.repo === selected.repo && p.number === selected.number) ?? selected;
  const [info, setInfo] = useState<ReviewInfo>();
  const [files, setFiles] = useState<PullFiles>();
  const [problem, setProblem] = useState<string>();
  const [revision, refresh] = useState(0);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [split, setSplit] = useState(true);
  const [wrapping, setWrapping] = useState<Record<string, boolean>>({});
  // Images whose text (an SVG's, say) is shown instead of the picture, by `wrapKey`.
  const [asCode, setAsCode] = useState<Record<string, boolean>>({});
  const [tree, setTree] = useState(true);
  const [fontSize, setFontSize] = useState<DiffFontSize>(rememberedDiffFontSize);
  const [treeWidth, setTreeWidth] = useState(rememberedTreeWidth);
  const [splitShare, setSplitShare] = useState(rememberedSplitShare);
  const [filter, setFilter] = useState("");
  const [done, setDone] = useState("");
  const [showInfo, setShowInfo] = useState(false);
  // Auto-merge as last turned on or off here, until the review is read again.
  const [autoMerge, setAutoMerge] = useState<boolean>();
  const action = useAction();
  const key = `${current.repo}#${current.number}`;
  const ordered = useMemo(() => (files ? treeOrder(files.files) : []), [files]);
  const index = Math.max(
    0,
    ordered.findIndex((f) => f.path === paths[key]),
  );
  const file = ordered[index];
  const wrapKey = `${key}:${file?.path}`;
  const wrap = wrapping[wrapKey] ?? wrapsByDefault(file?.path ?? "");
  const readImage = actions?.image;
  const image = Boolean(file && readImage && imageType(file.path));
  const showsImage = image && !asCode[wrapKey];
  // A binary file that isn't shown as an image has no sides to set apart.
  const binary = Boolean(file && !showsImage && isBinary(file));
  const prIndex = pulls.findIndex((p) => p.repo === current.repo && p.number === current.number);
  function moveFile(delta: number) {
    const next = ordered[index + delta];
    if (next) setPaths((previous) => ({ ...previous, [key]: next.path }));
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.showModal();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    let active = true;
    setFiles(undefined);
    setInfo(undefined);
    setProblem(undefined);
    setDone("");
    setAutoMerge(undefined);
    (async () => {
      const loaded = await actions?.files?.(current);
      const details = await actions?.review?.read(current);
      return [loaded, details] as const;
    })()
      .then(([loaded, details]) => {
        if (!active) return;
        if (details && details.pull.sha !== current.sha)
          throw new Error("New commits arrived. Refresh the dashboard and reopen this review.");
        setFiles(loaded);
        setInfo(details);
      })
      .catch((error) => {
        if (active) setProblem(reasonOf(error));
      });
    return () => {
      active = false;
    };
  }, [actions, current.repo, current.number, current.sha, revision]);
  const read = info?.pull ?? current;
  const pull = autoMerge === undefined ? read : { ...read, autoMerge };
  const fresh =
    info?.pull.sha === current.sha && info.pull.repo === current.repo && info.pull.number === current.number;
  return (
    <dialog
      ref={dialog}
      class="pull-review"
      data-diff-font={fontSize}
      aria-labelledby="review-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          moveFile(event.key === "ArrowDown" ? 1 : -1);
        }
      }}
    >
      <header class="review-header">
        <Icon name="pull-request" size={36} class="review-pr-icon" />
        <div class="review-heading">
          <p class="review-repository">
            {pull.repo} #{pull.number}
          </p>
          <h2 id="review-title">{pull.title}</h2>
          <div class="review-metadata">
            <span class="review-branch">
              <Icon name="pull-request" />
              <code>{pull.head}</code>
            </span>
            <span>→</span>
            <span class="review-branch">
              <Icon name="pull-request" />
              <code>{pull.base}</code>
            </span>
            <span class={`review-checks review-checks-${summarize(pull.checks)}`}>
              <Icon name={summarize(pull.checks) === "passed" ? "check" : "attention"} />
              Checks: {summarize(pull.checks)}
            </span>
            {(pull.draft || pull.mergeState !== "clean") && (
              <span class="review-state">{pull.draft ? "Draft" : pull.mergeState}</span>
            )}
            {pull.autoMerge && <span class="review-state">Auto-merge</span>}
          </div>
        </div>
        <div class="review-controls">
          <button
            type="button"
            aria-haspopup="dialog"
            title="Description, checks and reviews"
            onClick={() => setShowInfo(true)}
          >
            <Icon name="info" /> PR info
          </button>
          <button
            type="button"
            disabled={action.busy !== undefined || prIndex <= 0}
            onClick={() => {
              const next = pulls[prIndex - 1];
              if (next) select(next);
            }}
          >
            <span aria-hidden="true">‹</span> Previous PR
          </button>
          <button
            type="button"
            disabled={action.busy !== undefined || prIndex < 0 || prIndex >= pulls.length - 1}
            onClick={() => {
              const next = pulls[prIndex + 1];
              if (next) select(next);
            }}
          >
            Next PR <span aria-hidden="true">›</span>
          </button>
          <ExternalLink href={pull.url} class="button">
            Open on GitHub ↗
          </ExternalLink>
          <button
            type="button"
            class="primary"
            disabled={!fresh || !info?.canApprove || !!action.busy || !!done}
            title={
              info?.canApprove
                ? "Approve this commit"
                : "Approval unavailable for drafts, your own PR, or while loading"
            }
            onClick={() =>
              action.run("approve", async () => {
                await actions?.review?.approve(pull);
                setDone("Approved");
              })
            }
          >
            <Icon name="check" /> Approve
          </button>
          {actions?.pulls && isDependabot(pull) && (
            <button
              type="button"
              title="Comment “@dependabot rebase” so Dependabot rebases it onto its base"
              disabled={action.busy !== undefined || !!done}
              onClick={() => {
                const pulls = actions.pulls;
                if (!pulls) return;
                // Dependabot pushes a new head, so what is shown here is about to be out of date: the review closes
                // at once and the page below says how asking went.
                if (background) {
                  background.start(pull, "rebase", async () => {
                    await pulls.requestRebase(pull);
                    return { merged: false };
                  });
                  onClose();
                  return;
                }
                action.run("rebase", async () => {
                  await pulls.requestRebase(pull);
                  setDone("Asked Dependabot to rebase");
                });
              }}
            >
              <Icon name="refresh" /> {action.busy === "rebase" ? "Asking…" : "Rebase"}
            </button>
          )}
          {actions?.pulls && (pull.autoMerge || !pull.draft) && (
            <AutoMergeButton
              pull={pull}
              actions={actions.pulls}
              busy={action.busy === "autoMerge"}
              disabled={!fresh || action.busy !== undefined || done === "Merged"}
              run={(name, task) => {
                const pulls = actions.pulls;
                // Nothing is left to do here once the PR merges, or will merge, by itself, so the review closes at
                // once and the page below says how turning it on went.
                if (background && pulls && !pull.autoMerge) {
                  background.start(pull, "autoMerge", () => pulls.setAutoMerge(pull, true));
                  onClose();
                  return;
                }
                action.run(name, task);
              }}
              onDone={({ enabled, merged }) => {
                setAutoMerge(enabled);
                if (merged) setDone("Merged");
                if (enabled) onClose();
              }}
            />
          )}
          <span class="review-merge">
            <ConfirmButton
              label="Merge"
              // In a GitHub stack, the open pull requests under it merge with it.
              confirmLabel={(pull.stack?.position ?? 1) > 1 ? "Confirm merge with those under it" : "Confirm merge"}
              title={
                (pull.stack?.position ?? 1) > 1 ? "Merges the open pull requests under it in its stack too" : undefined
              }
              busyLabel="Merging…"
              busy={action.busy === "merge"}
              disabled={
                !fresh ||
                !info?.canMerge ||
                !actions?.pulls ||
                !!action.busy ||
                done === "Merged" ||
                !["passed", "none"].includes(summarize(pull.checks))
              }
              onConfirm={() => {
                const merge = async () => {
                  const latest = await actions?.review?.read(pull);
                  if (
                    !latest?.canMerge ||
                    latest.pull.sha !== pull.sha ||
                    !["passed", "none"].includes(summarize(latest.pull.checks))
                  )
                    throw new Error("Merge eligibility changed. Refresh and review it again.");
                  await actions?.pulls?.merge(pull);
                };
                // The review closes at once; the page below says how the merge went.
                if (background) {
                  background.start(pull, "merge", async () => {
                    await merge();
                    return { merged: true };
                  });
                  onClose();
                  return;
                }
                action.run("merge", async () => {
                  await merge();
                  setDone("Merged");
                });
              }}
            />
          </span>
        </div>
        <button class="review-close" type="button" onClick={onClose} aria-label="Close PR review">
          ×
        </button>
      </header>
      {(problem || action.problem) && (
        <p role="alert">
          {problem ?? action.problem}{" "}
          <button type="button" onClick={() => refresh((n) => n + 1)}>
            Refresh review
          </button>
        </p>
      )}
      {done && <p role="status">{done}</p>}
      {showInfo && (
        <PullInfo
          pull={pull}
          info={info}
          status={
            problem
              ? "PR information could not be loaded."
              : actions?.review
                ? "Loading PR information…"
                : "PR information is unavailable."
          }
          onClose={() => setShowInfo(false)}
        />
      )}
      {files?.truncated && <p role="status">Only the first 300 files are shown. Review remaining files on GitHub.</p>}
      <div
        class={`review-body ${tree ? "" : "review-no-tree"}`}
        style={treeWidth === undefined ? undefined : `--tree-width: ${treeWidth}px`}
      >
        {tree && (
          <nav aria-label="Changed files" class="review-tree">
            <div class="review-tree-heading">
              <Icon name="file" size={20} />
              <strong>Changed files</strong>
              <span class="review-count">{files?.files.length ?? 0}</span>
            </div>
            <label class="review-search">
              <Icon name="search" />
              <input
                type="search"
                aria-label="Filter changed files"
                placeholder="Filter files…"
                value={filter}
                onInput={(event) => setFilter(event.currentTarget.value)}
              />
            </label>
            <div class="review-tree-list">
              <FileTree
                files={(files?.files ?? []).filter((item) => item.path.toLowerCase().includes(filter.toLowerCase()))}
                selected={file?.path}
                choose={(path) => setPaths((previous) => ({ ...previous, [key]: path }))}
              />
              {files && !files.files.some((item) => item.path.toLowerCase().includes(filter.toLowerCase())) && (
                <p class="empty">No matching files.</p>
              )}
            </div>
            {/* The dashboard's own read when it is of this commit: it keeps up as the checks run. */}
            <ReviewChecks checks={withWorkflows((current.sha === pull.sha ? current : pull).checks, info?.workflows)} />
          </nav>
        )}
        {tree && <TreeDivider width={treeWidth} setWidth={setTreeWidth} />}
        <section
          class="review-code"
          aria-label="File diff"
          style={split && splitShare !== undefined ? `--split: ${Math.round(splitShare * 1000) / 10}%` : undefined}
        >
          <div class="review-toolbar">
            <div class="review-file-title">
              {file ? (
                <img class="review-file-icon" src={fileIcon(file.path)} alt="" width="20" height="20" />
              ) : (
                <Icon name="file" size={20} />
              )}
              <strong title={file?.path}>{file?.path ?? "File diff"}</strong>
              {file && (
                <span class="review-stats">
                  <span>+{file.additions}</span>
                  <span>−{file.deletions}</span>
                </span>
              )}
            </div>
            <div class="review-file-navigation">
              <span>
                {files ? `${index + (file ? 1 : 0)} of ${files.files.length} files` : "Loading files…"}
                <span class="review-shortcut"> · Alt+↑/↓</span>
              </span>
              <button type="button" disabled={index === 0} onClick={() => moveFile(-1)}>
                Previous file
              </button>
              <button type="button" disabled={!files || index >= files.files.length - 1} onClick={() => moveFile(1)}>
                Next file
              </button>
            </div>
            <button
              type="button"
              aria-pressed={wrap}
              disabled={!file || showsImage || isBinary(file)}
              onClick={() => setWrapping((previous) => ({ ...previous, [wrapKey]: !wrap }))}
            >
              Wrap lines
            </button>
            {image && file && usablePatch(file) && (
              <button
                type="button"
                aria-pressed={!showsImage}
                onClick={() => setAsCode((previous) => ({ ...previous, [wrapKey]: showsImage }))}
              >
                Show code
              </button>
            )}
            <fieldset class="review-view-controls" aria-label="Diff layout">
              <button type="button" aria-pressed={split} onClick={() => setSplit(true)}>
                Split
              </button>
              <button type="button" aria-pressed={!split} onClick={() => setSplit(false)}>
                Unified
              </button>
            </fieldset>
            <fieldset class="review-view-controls review-font-controls" aria-label="Code text size">
              {DIFF_FONT_SIZES.map(({ value, label }) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={fontSize === value}
                  aria-label={`${label} text`}
                  title={`${label} text`}
                  onClick={() => {
                    setFontSize(value);
                    rememberDiffFontSize(value);
                  }}
                >
                  <span class={`review-font-glyph review-font-${value}`} aria-hidden="true">
                    A
                  </span>
                </button>
              ))}
            </fieldset>
            <button type="button" aria-expanded={tree} onClick={() => setTree(!tree)}>
              {tree ? "Hide" : "Show"} files
            </button>
          </div>
          <div class="review-split-area">
            <div class={`review-column-headings ${split && !binary ? "" : "review-unified-heading"}`}>
              {split && !binary && (
                <span>
                  − Before <span>({pull.base})</span>
                </span>
              )}
              <span>
                + {binary ? "Binary file" : split ? "After" : "Changes"} <span>({pull.head})</span>
              </span>
            </div>
            <section class="review-code-scroll" key={`${key}:${file?.path}:${split}`} aria-label="Scrollable code diff">
              {file && showsImage && readImage ? (
                <ImageDiff pull={current} file={file} split={split} read={readImage} />
              ) : file && isBinary(file) ? (
                <BinaryNote pull={current} file={file} />
              ) : file ? (
                <FileDiff file={file} split={split} wrap={wrap} fontSize={fontSize} />
              ) : (
                <p class="empty">
                  {problem
                    ? "Diff could not be loaded. Refresh to try again."
                    : files
                      ? "No changed files."
                      : "Loading diff…"}
                </p>
              )}
            </section>
            {split && file && (showsImage || usablePatch(file)) && (
              <SplitDivider share={splitShare} setShare={setSplitShare} />
            )}
          </div>
        </section>
      </div>
    </dialog>
  );
}
