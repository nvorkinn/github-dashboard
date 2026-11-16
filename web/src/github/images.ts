import type { Auth } from "../auth.ts";
import type { ChangedFile, FileImage, FileSide, PullRequest, ReadImage } from "../model.ts";
import { GitHubError } from "./api.ts";

/** Images larger than this are left to GitHub: they would be slow to read and heavy to hold as a `data:` address. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

/** The media type a browser shows `path` as an image with, or nothing when it isn't an image a browser can show. */
export function imageType(path: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension ? IMAGE_TYPES[extension] : undefined;
}

/** Whether the file's side exists: an added file has no before, a removed one no after. */
export function hasSide(file: ChangedFile, side: FileSide): boolean {
  return side === "before" ? file.status !== "added" : file.status !== "removed";
}

/** A file that is too large to show here. */
export class ImageTooLargeError extends Error {
  constructor() {
    super("This image is larger than 10 MB. Open it on GitHub.");
    this.name = "ImageTooLargeError";
  }
}

function contentsPath(repo: string, path: string, ref: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`;
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("The image could not be read."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Reads changed images from GitHub, kept in memory by commit. The "before" side is the file at the commit the pull
 * request branched from (the merge base), as GitHub's own diff compares, and the "after" side the file at its head.
 * Images are handed over as `data:` addresses, which the page's content security policy lets an `<img>` show.
 */
export function createImageReader(auth: Auth): ReadImage {
  const bases = new Map<string, Promise<string>>();
  const images = new Map<string, Promise<FileImage>>();

  async function get(path: string, accept?: string): Promise<Response> {
    const response = await auth.github(path, accept ? { headers: { Accept: accept } } : undefined);
    if (!response.ok) throw new GitHubError(path, response.status, undefined);
    return response;
  }

  function mergeBase(pull: PullRequest): Promise<string> {
    const key = `${pull.repo}#${pull.number}@${pull.sha}`;
    let base = bases.get(key);
    if (!base) {
      const ref = pull.base.split("/").map(encodeURIComponent).join("/");
      base = get(`repos/${pull.repo}/compare/${ref}...${pull.sha}?per_page=1`)
        .then((response) => response.json())
        .then((body: { merge_base_commit?: { sha?: unknown } }) => {
          const sha = body?.merge_base_commit?.sha;
          if (typeof sha !== "string") throw new Error("GitHub didn't say where this pull request branched from.");
          return sha;
        });
      bases.set(key, base);
      base.catch(() => bases.delete(key));
    }
    return base;
  }

  async function read(pull: PullRequest, file: ChangedFile, side: FileSide): Promise<FileImage> {
    const type = imageType(file.path);
    if (!type) throw new Error("This file isn't an image.");
    const ref = side === "before" ? await mergeBase(pull) : pull.sha;
    const path = side === "before" ? (file.previousPath ?? file.path) : file.path;
    const response = await get(contentsPath(pull.repo, path, ref), "application/vnd.github.raw");
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_IMAGE_BYTES) throw new ImageTooLargeError();
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ImageTooLargeError();
    // GitHub sends raw files as plain bytes; the type comes from the name so the browser decodes them as an image.
    return { url: await dataUrl(new Blob([bytes], { type })), bytes: bytes.byteLength };
  }

  return (pull, file, side) => {
    const key = `${pull.repo}#${pull.number}@${pull.sha}:${side}:${file.previousPath ?? ""}:${file.path}`;
    let image = images.get(key);
    if (!image) {
      image = read(pull, file, side);
      images.set(key, image);
      image.catch(() => images.delete(key));
    }
    return image;
  };
}
