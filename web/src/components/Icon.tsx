import type { ComponentChildren } from "preact";

export type IconName =
  | "attention"
  | "check"
  | "command"
  | "overview"
  | "pull-request"
  | "release"
  | "search"
  | "workflow";

const paths: Record<IconName, ComponentChildren> = {
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
