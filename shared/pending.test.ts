import { expect, test } from "vitest";
import { pendingSnapshot, pullLabel } from "./pending.ts";

const one = {
  id: "a",
  repo: "octo/app",
  pulls: [{ repo: "octo/lib", number: 2, title: "Lib", merged: { at: "2026-11-19T10:00:00Z", sha: "a".repeat(40) } }],
  by: "octo",
  createdAt: "2026-11-19T09:00:00Z",
  state: "released",
  tag: "v1.2.0",
  url: "https://github.com/octo/app/releases/tag/v1.2.0",
};

test("a snapshot keeps what reads as pending releases and leaves out the rest", () => {
  expect(
    pendingSnapshot({
      configured: true,
      pending: [
        one,
        { ...one, id: "b", state: "unheard-of" },
        { ...one, id: "c", pulls: [] },
        { ...one, id: "d", url: "https://evil.example/" },
      ],
    }),
  ).toEqual({
    configured: true,
    pending: [one, { ...one, id: "d", url: undefined }].map((p) => {
      const { url, ...rest } = p;
      return url ? p : rest;
    }),
  });
  expect(pendingSnapshot({ configured: "yes", pending: [] })).toBeUndefined();
});

test("a pull request is named as briefly as beside its project allows", () => {
  expect(pullLabel({ repo: "octo/app", number: 1 }, "octo/app")).toBe("#1");
  expect(pullLabel({ repo: "octo/lib", number: 2 }, "octo/app")).toBe("lib#2");
  expect(pullLabel({ repo: "other/lib", number: 3 }, "octo/app")).toBe("other/lib#3");
});
