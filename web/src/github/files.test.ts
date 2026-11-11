import { expect, test } from "vitest";
import { pull } from "../components/testing.ts";
import { createApi } from "./api.ts";
import { createFilesReader, MAX_FILES, readPullFiles } from "./files.ts";
import { fakeGitHub } from "./testing.ts";

const PATH = "repos/octocat/weather-station/pulls/1/files";

function files(count: number, from = 0) {
  return Array.from({ length: count }, (_, index) => ({
    filename: `src/file${from + index}.ts`,
    status: "modified",
    additions: 2,
    deletions: 1,
    patch: "@@ -1 +1 @@",
  }));
}

const page = (n: number) => `${PATH}?per_page=100&page=${n}`;

test("reads each file's path, status and counts, with a renamed one's old name", async () => {
  const { auth, calls } = fakeGitHub({
    [page(1)]: [
      { filename: "README.md", status: "added", additions: 10, deletions: 0 },
      { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed", additions: 1, deletions: 1 },
    ],
  });
  const read = await readPullFiles(createApi(auth), "octocat/weather-station", 1);
  expect(read).toEqual({
    files: [
      { path: "README.md", previousPath: undefined, status: "added", additions: 10, deletions: 0 },
      { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", additions: 1, deletions: 1 },
    ],
    truncated: false,
  });
  expect(calls).toEqual([page(1)]);
});

test("reads page after page until one isn't full", async () => {
  const { auth, calls } = fakeGitHub({ [page(1)]: files(100), [page(2)]: files(30, 100) });
  const read = await readPullFiles(createApi(auth), "octocat/weather-station", 1);
  expect(read.files).toHaveLength(130);
  expect(read.files[129]?.path).toBe("src/file129.ts");
  expect(read.truncated).toBe(false);
  expect(calls).toEqual([page(1), page(2)]);
});

test("stops at 300 files and says there are more", async () => {
  const { auth, calls } = fakeGitHub({
    [page(1)]: files(100),
    [page(2)]: files(100, 100),
    [page(3)]: files(100, 200),
    [page(4)]: files(100, 300),
    [page(5)]: files(100, 400),
  });
  const read = await readPullFiles(createApi(auth), "octocat/weather-station", 1);
  expect(read.files).toHaveLength(MAX_FILES);
  expect(read.truncated).toBe(true);
  expect(calls).toEqual([page(1), page(2), page(3), page(4)]);
});

test("exactly 300 files are all there is", async () => {
  const { auth } = fakeGitHub({
    [page(1)]: files(100),
    [page(2)]: files(100, 100),
    [page(3)]: files(100, 200),
    [page(4)]: [],
  });
  const read = await readPullFiles(createApi(auth), "octocat/weather-station", 1);
  expect(read.files).toHaveLength(300);
  expect(read.truncated).toBe(false);
});

test("reads once for each head commit", async () => {
  const { auth, calls } = fakeGitHub({
    [page(1)]: files(1),
    "repos/octocat/weather-station/pulls/2/files?per_page=100&page=1": files(2),
  });
  const read = createFilesReader(createApi(auth));
  const first = await read(pull({ sha: "aaa" }));
  expect(await read(pull({ sha: "aaa" }))).toBe(first);
  expect(calls).toHaveLength(1);
  // A new push is read again, and so is another pull request.
  await read(pull({ sha: "bbb" }));
  expect(calls).toHaveLength(2);
  expect((await read(pull({ number: 2, sha: "aaa" }))).files).toHaveLength(2);
  expect(calls).toHaveLength(3);
  // Two at once ask GitHub once.
  await Promise.all([read(pull({ sha: "ccc" })), read(pull({ sha: "ccc" }))]);
  expect(calls).toHaveLength(4);
});

test("a read that failed is read again next time", async () => {
  let fail = true;
  const { auth, calls } = fakeGitHub({
    [page(1)]: () => (fail ? Response.json({ message: "Server Error" }, { status: 502 }) : Response.json(files(1))),
  });
  const read = createFilesReader(createApi(auth));
  await expect(read(pull())).rejects.toThrow("GitHub answered 502");
  fail = false;
  expect((await read(pull())).files).toHaveLength(1);
  expect(calls).toHaveLength(2);
});
