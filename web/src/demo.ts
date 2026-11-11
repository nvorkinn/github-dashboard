/**
 * The demo: the page running on built-in sample data, with no relay, sign-in or GitHub behind it. Each pull request's
 * preview is built this way (`npm run build:demo`), so a change can be looked at and clicked through before merging.
 * Only a demo build loads this file.
 */
export function installDemo(): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    const answer = url.origin === location.origin ? sample(url.pathname) : undefined;
    return answer ?? realFetch(input, init);
  };
}

/** The sample answer for one of the relay's paths, or nothing for a path the demo doesn't stand in for. */
function sample(path: string): Response | undefined {
  if (path.endsWith("/healthz")) {
    return new Response("ok");
  }
  return undefined;
}
