const SEMVER = /^(v?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The next minor version after the highest of these release tags, with the `v` of that tag or without it, and the
 * tag it follows. A prerelease counts, below its own release: after `v3.0.0-rc.2` comes `v3.1.0`. Tags that aren't
 * versions are passed over; with no release at all the first is `v1.0.0`. Undefined when there are tags and none of
 * them is a version, so the next one isn't known. The page's Release button and the relay's pending releases both
 * name the next release this way.
 */
export function nextVersion(tags: string[]): { previous: string | undefined; tag: string } | undefined {
  if (tags.length === 0) {
    return { previous: undefined, tag: "v1.0.0" };
  }
  let best: { tag: string; key: number[]; prefix: string } | undefined;
  for (const tag of tags) {
    const match = SEMVER.exec(tag);
    if (!match) {
      continue;
    }
    const key = [Number(match[2]), Number(match[3]), Number(match[4]), match[5] === undefined ? 1 : 0];
    if (!best || compare(key, best.key) > 0) {
      best = { tag, key, prefix: match[1] ?? "" };
    }
  }
  if (!best) {
    return undefined;
  }
  const [major, minor] = best.key as [number, number];
  return { previous: best.tag, tag: `${best.prefix}${major}.${minor + 1}.0` };
}

function compare(a: number[], b: number[]): number {
  for (let index = 0; index < a.length; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
