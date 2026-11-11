import { Diff2HtmlUI } from "diff2html/lib/ui/js/diff2html-ui-slim.js";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ReviewInfo } from "../github/review.ts";
import type { ChangedFile, PullFiles, PullRequest } from "../model.ts";
import { summarize } from "../model.ts";
import { ConfirmButton, reasonOf, useAction, useActions } from "./actions.tsx";
import { ExternalLink } from "./ExternalLink.tsx";
import "diff2html/bundles/css/diff2html.min.css";
import "highlight.js/styles/github.css";
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

function FileDiff({ file, split }: { file: ChangedFile; split: boolean }) {
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
      },
    );
    ui.draw();
    target.current.scrollTop = 0;
    return () => {
      if (target.current) target.current.replaceChildren();
    };
  }, [file, split, usable]);
  return usable ? (
    <div ref={target} class="review-diff" />
  ) : (
    <p class="empty">
      Preview unavailable: this patch is missing, incomplete, binary, or too large. Open on GitHub to review it.
    </p>
  );
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
      {[...folders].map(([folder, group]) => (
        <details key={folder} open>
          <summary>{folder}</summary>
          <div class="review-folder">
            <FileTree files={group} selected={selected} choose={choose} prefix={`${prefix}${folder}`} />
          </div>
        </details>
      ))}
      {leaves.map((file) => (
        <button
          type="button"
          key={file.path}
          aria-current={file.path === selected ? "true" : undefined}
          title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
          onClick={() => choose(file.path)}
        >
          <span>{file.path.slice(prefix.length)}</span>
          <small>
            {file.status} · +{file.additions} −{file.deletions}
          </small>
        </button>
      ))}
    </>
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
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, select] = useState(initial);
  const current = pulls.find((p) => p.repo === selected.repo && p.number === selected.number) ?? selected;
  const [info, setInfo] = useState<ReviewInfo>();
  const [files, setFiles] = useState<PullFiles>();
  const [problem, setProblem] = useState<string>();
  const [revision, refresh] = useState(0);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [split, setSplit] = useState(true);
  const [tree, setTree] = useState(true);
  const [done, setDone] = useState("");
  const action = useAction();
  const key = `${current.repo}#${current.number}`;
  const index = Math.max(0, files?.files.findIndex((f) => f.path === paths[key]) ?? 0);
  const file = files?.files[index];
  const prIndex = pulls.findIndex((p) => p.repo === current.repo && p.number === current.number);
  function moveFile(delta: number) {
    const next = files?.files[index + delta];
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
  const pull = info?.pull ?? current;
  const fresh =
    info?.pull.sha === current.sha && info.pull.repo === current.repo && info.pull.number === current.number;
  return (
    <dialog
      ref={dialog}
      class="pull-review"
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
        <div>
          <h2 id="review-title">
            {pull.repo} #{pull.number} · {pull.title}
          </h2>
          <p>
            <code>{pull.head}</code> → <code>{pull.base}</code> · {pull.draft ? "Draft" : pull.mergeState} · Checks:{" "}
            {summarize(pull.checks)}
          </p>
        </div>
        <div class="review-controls">
          <button
            type="button"
            disabled={action.busy !== undefined || prIndex <= 0}
            onClick={() => {
              const next = pulls[prIndex - 1];
              if (next) select(next);
            }}
          >
            Previous PR
          </button>
          <button
            type="button"
            disabled={action.busy !== undefined || prIndex < 0 || prIndex >= pulls.length - 1}
            onClick={() => {
              const next = pulls[prIndex + 1];
              if (next) select(next);
            }}
          >
            Next PR
          </button>
          <button
            type="button"
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
            Approve
          </button>
          <ConfirmButton
            label="Merge"
            confirmLabel="Confirm merge"
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
            onConfirm={() =>
              action.run("merge", async () => {
                const latest = await actions?.review?.read(pull);
                if (
                  !latest?.canMerge ||
                  latest.pull.sha !== pull.sha ||
                  !["passed", "none"].includes(summarize(latest.pull.checks))
                )
                  throw new Error("Merge eligibility changed. Refresh this review.");
                await actions?.pulls?.merge(pull);
                setDone("Merged");
              })
            }
          />
          <ExternalLink href={pull.url}>Open on GitHub</ExternalLink>
          <button type="button" onClick={onClose} aria-label="Close PR review">
            Close ×
          </button>
        </div>
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
      <details class="review-info">
        <summary>PR information · description, checks, reviews</summary>
        {info ? (
          <>
            <p class="review-description">{info.description || "No description."}</p>
            <ul>
              {pull.checks.map((check, i) => (
                <li key={`${check.name}-${i}`}>
                  {check.name}: {check.state}
                </li>
              ))}
            </ul>
            <ul>
              {info.reviews.map((review, i) => (
                <li key={i}>
                  {review.user?.login ?? "Deleted user"}: {review.state}
                  <p>{review.body}</p>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>
            {problem
              ? "PR information could not be loaded."
              : actions?.review
                ? "Loading PR information…"
                : "PR information is unavailable."}
          </p>
        )}
      </details>
      <div class="review-toolbar">
        <button type="button" aria-expanded={tree} onClick={() => setTree(!tree)}>
          {tree ? "Hide" : "Show"} files
        </button>
        <button type="button" aria-pressed={split} onClick={() => setSplit(true)}>
          Split
        </button>
        <button type="button" aria-pressed={!split} onClick={() => setSplit(false)}>
          Unified
        </button>
        <button type="button" disabled={index === 0} onClick={() => moveFile(-1)}>
          Previous file
        </button>
        <button type="button" disabled={!files || index >= files.files.length - 1} onClick={() => moveFile(1)}>
          Next file
        </button>
        <span>
          {file?.path} · {files ? `${index + (file ? 1 : 0)} / ${files.files.length}` : "Loading files…"} · Alt+↑/↓
        </span>
      </div>
      {files?.truncated && <p role="status">Only the first 300 files are shown. Review remaining files on GitHub.</p>}
      <div class={`review-body ${tree ? "" : "review-no-tree"}`}>
        {tree && (
          <nav aria-label="Changed files" class="review-tree">
            <FileTree
              files={files?.files ?? []}
              selected={file?.path}
              choose={(path) => setPaths((previous) => ({ ...previous, [key]: path }))}
            />
          </nav>
        )}
        <section class="review-code" aria-label="File diff">
          {file ? (
            <FileDiff file={file} split={split} />
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
      </div>
    </dialog>
  );
}
