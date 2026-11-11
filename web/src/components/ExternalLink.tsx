import type { ComponentChildren } from "preact";

/** A link away from the dashboard, to GitHub or a demo. It opens in a new tab, so the dashboard stays open. */
export function ExternalLink({
  href,
  class: className,
  title,
  children,
}: {
  href: string;
  class?: string | undefined;
  title?: string | undefined;
  children: ComponentChildren;
}) {
  return (
    <a href={href} class={className} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
