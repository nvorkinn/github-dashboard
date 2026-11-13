import { useLayoutEffect, useRef } from "preact/hooks";
import { renderMarkdown } from "../markdown.ts";
import "./Markdown.css";

/** Markdown someone else wrote, such as a PR's description, shown as GitHub would show it, and made safe first. */
export function Markdown({ text, base, class: className }: { text: string; base?: string; class?: string }) {
  const target = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    target.current?.replaceChildren(renderMarkdown(text, base));
  }, [text, base]);
  return <div ref={target} class={`markdown ${className ?? ""}`} />;
}
