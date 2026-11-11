import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { codeChallenge, open, sameString, seal } from "./crypto.ts";

const key = randomBytes(32);

test("opens what it sealed", () => {
  const sealed = seal(key, "refresh", "ghr_secret");
  expect(sealed).not.toContain("ghr_secret");
  expect(open(key, "refresh", sealed)).toBe("ghr_secret");
});

test("seals the same value differently each time", () => {
  expect(seal(key, "refresh", "ghr_secret")).not.toBe(seal(key, "refresh", "ghr_secret"));
});

test("refuses a value that was changed anywhere", () => {
  const bytes = Buffer.from(seal(key, "refresh", "ghr_secret"), "base64url");
  for (let index = 0; index < bytes.length; index++) {
    const changed = Buffer.from(bytes);
    changed[index] = (changed[index] ?? 0) ^ 1;
    expect(open(key, "refresh", changed.toString("base64url")), `byte ${index}`).toBeUndefined();
  }
});

test("refuses a value sealed with another key or for another purpose", () => {
  const sealed = seal(key, "refresh", "ghr_secret");
  expect(open(randomBytes(32), "refresh", sealed)).toBeUndefined();
  expect(open(key, "something else", sealed)).toBeUndefined();
});

test("refuses what isn't a sealed value at all", () => {
  expect(open(key, "refresh", "")).toBeUndefined();
  expect(open(key, "refresh", "not a cookie of ours")).toBeUndefined();
});

test("compares strings of any length", () => {
  expect(sameString("abc", "abc")).toBe(true);
  expect(sameString("abc", "abd")).toBe(false);
  expect(sameString("abc", "abcd")).toBe(false);
});

test("makes the PKCE challenge of RFC 7636's example", () => {
  expect(codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});
