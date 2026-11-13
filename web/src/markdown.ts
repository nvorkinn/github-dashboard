import DOMPurify from "dompurify";
import { Marked } from "marked";

// GitHub's flavour, with a line break wherever the text has one, as GitHub shows PR descriptions and comments.
const marked = new Marked({ gfm: true, breaks: true, async: false });

/**
 * Markdown that someone else wrote, such as a PR's description, as a fragment of safe HTML. The HTML that marked makes
 * goes through DOMPurify, which keeps only plain markup: no scripts, event handlers, styles, forms or `javascript:`
 * links. What is left is then made to fit the page:
 *
 * - links open in a new tab, and relative ones lead where they would on GitHub, from `base`;
 * - images become links to them, since the page's content security policy lets it show only GitHub's avatars, and an
 *   image from anywhere else could tell its server who looked;
 * - task list checkboxes can't be ticked here.
 */
export function renderMarkdown(text: string, base?: string): DocumentFragment {
  const html = marked.parse(text) as string;
  const fragment = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "button", "select", "textarea", "video", "audio", "source", "track", "picture"],
    FORBID_ATTR: ["style", "class", "id", "target"],
    RETURN_DOM_FRAGMENT: true,
  });
  for (const image of [...fragment.querySelectorAll("img")]) {
    const source = safeUrl(image.getAttribute("src"), base);
    const label = image.getAttribute("alt")?.trim() || "image";
    const document = image.ownerDocument;
    // A link can't hold another link, so an image that is already one becomes only its label.
    if (!source || image.closest("a")) {
      image.replaceWith(document.createTextNode(`[${label}]`));
    } else {
      const link = document.createElement("a");
      link.setAttribute("href", source);
      link.textContent = `[Image: ${label}]`;
      image.replaceWith(link);
    }
  }
  for (const link of fragment.querySelectorAll("a")) {
    const href = link.getAttribute("href");
    if (href?.startsWith("#")) continue;
    const target = safeUrl(href, base);
    if (target) {
      link.setAttribute("href", target);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    } else {
      link.removeAttribute("href");
    }
  }
  for (const input of [...fragment.querySelectorAll("input")]) {
    if (input.getAttribute("type") === "checkbox") {
      input.setAttribute("disabled", "");
    } else {
      input.remove();
    }
  }
  return fragment;
}

/** The address in full, if it is a web page or an email address; nothing for anything else. */
function safeUrl(value: string | null, base: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = base ? new URL(value, base) : new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
