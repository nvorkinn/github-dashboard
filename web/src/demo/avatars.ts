/** Drawn avatars in data: addresses, so the demo fetches nothing and the content security policy lets them through. */

function svg(body: string): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56">${body}</svg>`,
  )}`;
}

/** A person: head and shoulders in two colours. */
export function person(background: string, figure: string): string {
  return svg(
    `<rect width="56" height="56" fill="${background}"/>` +
      `<circle cx="28" cy="22" r="10" fill="${figure}"/>` +
      `<path d="M8 56a20 20 0 0 1 40 0z" fill="${figure}"/>`,
  );
}

/** A bot: a square head with two eyes and an antenna. */
export function bot(background: string, figure: string): string {
  return svg(
    `<rect width="56" height="56" fill="${background}"/>` +
      `<rect x="14" y="20" width="28" height="22" rx="4" fill="${figure}"/>` +
      `<path d="M28 20v-8" stroke="${figure}" stroke-width="3"/>` +
      `<circle cx="28" cy="11" r="3" fill="${figure}"/>` +
      `<circle cx="22" cy="30" r="3" fill="${background}"/>` +
      `<circle cx="34" cy="30" r="3" fill="${background}"/>`,
  );
}

export const AVATARS = {
  octocat: person("#dbe4ff", "#4263eb"),
  monalisa: person("#ffe3e3", "#e03131"),
  hubot: person("#d3f9d8", "#2f9e44"),
  defunkt: person("#fff3bf", "#e67700"),
  "dependabot[bot]": bot("#e7f5ff", "#1971c2"),
};
