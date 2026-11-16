import { useEffect, useState } from "preact/hooks";
import { hasSide, imageType } from "../github/images.ts";
import type { ChangedFile, FileImage, FileSide, PullRequest, ReadImage } from "../model.ts";
import { reasonOf } from "./actions.tsx";
import { ExternalLink } from "./ExternalLink.tsx";
import "./ImageDiff.css";

/** Whether a file has no text diff because it is binary: GitHub gives no patch and counts no lines for it. */
export function isBinary(file: ChangedFile): boolean {
  return !file.patch && file.additions === 0 && file.deletions === 0;
}

/** How many bytes, for people. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type Loaded = { status: "loaded"; image: FileImage; width?: number; height?: number };
type SideState = { status: "absent" } | { status: "loading" } | { status: "failed"; reason: string } | Loaded;

function ImagePane({
  side,
  state,
  file,
  labelled,
  onSize,
}: {
  side: FileSide;
  state: SideState;
  file: ChangedFile;
  labelled: boolean;
  onSize: (width: number, height: number) => void;
}) {
  const name = side === "before" ? (file.previousPath ?? file.path) : file.path;
  const kind = imageType(file.path)
    ?.replace(/^image\//, "")
    .replace(/\+xml$/, "")
    .toUpperCase();
  return (
    <figure
      class={`review-image-pane review-image-${side}`}
      aria-label={`${side === "before" ? "Before" : "After"} image`}
    >
      {labelled && <figcaption class="review-image-label">{side === "before" ? "− Before" : "+ After"}</figcaption>}
      {state.status === "absent" ? (
        <p class="review-image-note">
          {side === "before"
            ? "No image before: this pull request adds it."
            : "No image after: this pull request removes it."}
        </p>
      ) : state.status === "loading" ? (
        <p class="review-image-note">Loading image…</p>
      ) : state.status === "failed" ? (
        <p class="review-image-note">Image could not be loaded. {state.reason}</p>
      ) : (
        <>
          <div class="review-image-frame">
            <img
              src={state.image.url}
              alt={`${name}, ${side}`}
              onLoad={(event) => {
                const img = event.currentTarget;
                onSize(img.naturalWidth, img.naturalHeight);
              }}
            />
          </div>
          <p class="review-image-meta">
            {[
              kind,
              state.width && state.height ? `${state.width} × ${state.height}` : undefined,
              formatBytes(state.image.bytes),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </>
      )}
    </figure>
  );
}

/** A changed image, before beside after (or above it, in the unified layout). */
export function ImageDiff({
  pull,
  file,
  split,
  read,
}: {
  pull: PullRequest;
  file: ChangedFile;
  split: boolean;
  read: ReadImage;
}) {
  const [sides, setSides] = useState<Record<FileSide, SideState>>({
    before: { status: "loading" },
    after: { status: "loading" },
  });
  useEffect(() => {
    let active = true;
    const start = (side: FileSide): SideState => (hasSide(file, side) ? { status: "loading" } : { status: "absent" });
    setSides({ before: start("before"), after: start("after") });
    for (const side of ["before", "after"] as const) {
      if (!hasSide(file, side)) continue;
      read(pull, file, side).then(
        (image) => active && setSides((previous) => ({ ...previous, [side]: { status: "loaded", image } })),
        (error) =>
          active && setSides((previous) => ({ ...previous, [side]: { status: "failed", reason: reasonOf(error) } })),
      );
    }
    return () => {
      active = false;
    };
    // The pull request is read again with each refresh of the dashboard; only a new commit changes its images.
  }, [pull.repo, pull.number, pull.sha, pull.base, file, read]);
  const sized = (side: FileSide) => (width: number, height: number) =>
    setSides((previous) => {
      const state = previous[side];
      return state.status === "loaded" ? { ...previous, [side]: { ...state, width, height } } : previous;
    });
  return (
    <div class={`review-images ${split ? "review-images-split" : "review-images-unified"}`}>
      {(["before", "after"] as const).map((side) => (
        <ImagePane key={side} side={side} state={sides[side]} file={file} labelled={!split} onSize={sized(side)} />
      ))}
    </div>
  );
}

/** What stands in for a binary file that isn't an image this page can show. */
export function BinaryNote({ pull, file }: { pull: PullRequest; file: ChangedFile }) {
  const what =
    file.status === "added"
      ? "added"
      : file.status === "removed"
        ? "removed"
        : file.status === "renamed"
          ? "renamed"
          : "changed";
  return (
    <div class="review-binary">
      <p>
        <strong>Binary file {what}.</strong> There is no text to compare.
      </p>
      <p>
        <ExternalLink href={`${pull.url}/files`}>Open the pull request's files on GitHub</ExternalLink> to download it.
      </p>
    </div>
  );
}
