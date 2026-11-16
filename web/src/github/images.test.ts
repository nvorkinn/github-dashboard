// @vitest-environment happy-dom
import { expect, test } from "vitest";
import type { Auth } from "../auth.ts";
import { pull } from "../components/testing.ts";
import type { ChangedFile } from "../model.ts";
import { createImageReader, hasSide, imageType, MAX_IMAGE_BYTES } from "./images.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function fakeAuth(answer: (path: string) => Response) {
  const calls: { path: string; accept: string | null }[] = [];
  const auth: Auth = {
    state: () => ({ status: "signedIn" }),
    subscribe: () => () => {},
    start: async () => {},
    signOut: async () => true,
    async github(path, init) {
      calls.push({ path, accept: new Headers(init?.headers).get("Accept") });
      return answer(path);
    },
  };
  return { auth, calls };
}

const image = (fields: Partial<ChangedFile> = {}): ChangedFile => ({
  path: "docs/chart.png",
  previousPath: undefined,
  status: "modified",
  additions: 0,
  deletions: 0,
  ...fields,
});

test("knows images a browser can show by their names", () => {
  expect(imageType("docs/Chart.PNG")).toBe("image/png");
  expect(imageType("icon.svg")).toBe("image/svg+xml");
  expect(imageType("photo.jpeg")).toBe("image/jpeg");
  expect(imageType("data.bin")).toBeUndefined();
  expect(imageType("png")).toBeUndefined();
});

test("an added file has no before and a removed one no after", () => {
  expect(hasSide(image({ status: "added" }), "before")).toBe(false);
  expect(hasSide(image({ status: "added" }), "after")).toBe(true);
  expect(hasSide(image({ status: "removed" }), "after")).toBe(false);
  expect(hasSide(image({ status: "renamed" }), "before")).toBe(true);
});

test("reads after at the head and before at the merge base, raw, as data addresses, once each", async () => {
  const { auth, calls } = fakeAuth((path) =>
    path.includes("/compare/")
      ? Response.json({ merge_base_commit: { sha: "base999" } })
      : new Response(PNG, { headers: { "content-type": "application/octet-stream" } }),
  );
  const read = createImageReader(auth);
  const target = pull({ base: "release/2", sha: "abc1234" });
  const file = image({ path: "docs/new chart.png", previousPath: "docs/old chart.png", status: "renamed" });

  const after = await read(target, file, "after");
  const before = await read(target, file, "before");
  await read(target, file, "after");

  expect(after).toEqual({ url: "data:image/png;base64,iVBORw==", bytes: 4 });
  expect(before.url).toBe(after.url);
  expect(calls).toEqual([
    {
      path: "repos/octocat/weather-station/contents/docs/new%20chart.png?ref=abc1234",
      accept: "application/vnd.github.raw",
    },
    { path: "repos/octocat/weather-station/compare/release/2...abc1234?per_page=1", accept: null },
    {
      path: "repos/octocat/weather-station/contents/docs/old%20chart.png?ref=base999",
      accept: "application/vnd.github.raw",
    },
  ]);
});

test("refuses images over the limit and asks again after a failure", async () => {
  let status = 404;
  const { auth, calls } = fakeAuth(() =>
    status === 404
      ? new Response("", { status })
      : new Response(PNG, { headers: { "content-length": String(MAX_IMAGE_BYTES + 1) } }),
  );
  const read = createImageReader(auth);
  await expect(read(pull(), image(), "after")).rejects.toThrow("404");
  status = 200;
  await expect(read(pull(), image(), "after")).rejects.toThrow("larger than 10 MB");
  expect(calls).toHaveLength(2);
});
