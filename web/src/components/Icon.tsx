import type { ComponentChildren } from "preact";

export type IconName =
  | "file"
  | "folder"
  | "attention"
  | "check"
  | "command"
  | "notification"
  | "overview"
  | "pull-request"
  | "release"
  | "search"
  | "workflow"
  | "settings"
  | "copy"
  | "trash"
  | "bolt"
  | "merge"
  | "layers"
  | "refresh"
  | "info"
  | "eye"
  | "key";

const paths: Record<IconName, ComponentChildren> = {
  settings: (
    <>
      <path d="m9 3-.6 2.2-2 .9-2-.6-2 3.5 1.6 1.6v2.8L2.4 15l2 3.5 2-.6 2 .9L9 21h4l.6-2.2 2-.9 2 .6 2-3.5-1.6-1.6v-2.8L19.6 9l-2-3.5-2 .6-2-.9L13 3Z" />
      <circle cx="11" cy="12" r="3" />
    </>
  ),
  copy: (
    <>
      <path d="M14 3H5v14h3M14 3v5h5M14 3l5 5v13H8V8h6" />
      <path d="M11 12h5m-5 4h5" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
    </>
  ),
  bolt: <path d="m13 2-9 12h7l-1 8 10-13h-8l1-7Z" />,
  merge: (
    <>
      <circle cx="6" cy="4" r="2" />
      <circle cx="6" cy="20" r="2" />
      <circle cx="18" cy="7" r="2" />
      <path d="M6 6v12m0-5c8 0 12-1 12-4" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10h.01" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H5v20h14V7Z" />
      <path d="M14 2v6h5" />
    </>
  ),
  folder: <path d="M3 6h7l2 2h9v12H3Z" />,
  attention: (
    <>
      <path d="M12 3 2.6 20h18.8L12 3Z" />
      <path d="M12 9v5" />
      <path d="M12 17.5h.01" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  command: (
    <>
      <path d="M9 6v12a3 3 0 1 1-3-3h12a3 3 0 1 1-3 3V6a3 3 0 1 1 3 3H6a3 3 0 1 1 3-3Z" />
    </>
  ),
  notification: (
    <>
      <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" />
      <path d="M10 21h4" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9" />
      <path d="m16 7 3 3" />
    </>
  ),
  overview: (
    <>
      <path d="m3 11 9-8 9 8" />
      <path d="M5 10v10h14V10" />
      <path d="M9 20v-6h6v6" />
    </>
  ),
  "pull-request": (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="19" r="2" />
      <path d="M6 7v10" />
      <path d="M18 17v-5a4 4 0 0 0-4-4H9" />
      <path d="m12 5-3 3 3 3" />
    </>
  ),
  release: (
    <>
      <path d="M20 13 11 22l-9-9V3h10l8 8a1.4 1.4 0 0 1 0 2Z" />
      <circle cx="7" cy="8" r="1.5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  workflow: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m10 8 6 4-6 4V8Z" />
    </>
  ),
};

/** A small interface icon. It is decorative unless `label` gives it an accessible name. */
export function Icon({
  name,
  label,
  size = 16,
  class: className,
}: {
  name: IconName;
  label?: string | undefined;
  size?: number | undefined;
  class?: string | undefined;
}) {
  const classes = ["ui-icon", `ui-icon-${name}`, className].filter(Boolean).join(" ");
  return (
    <svg
      class={classes}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={label ? undefined : "true"}
      aria-label={label}
      role={label ? "img" : undefined}
    >
      {paths[name]}
    </svg>
  );
}
