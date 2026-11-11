import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { codeChallenge, open, sameString, seal, validWebhookSignature, webhookSignature } from "./crypto.ts";

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

test("signs a webhook body as the example in GitHub's documentation", () => {
  const body = Buffer.from("Hello, World!");
  const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
  expect(webhookSignature("It's a Secret to Everybody", body)).toBe(signature);
  expect(validWebhookSignature("It's a Secret to Everybody", body, signature)).toBe(true);
  expect(validWebhookSignature("It's a secret to everybody", body, signature)).toBe(false);
  expect(validWebhookSignature("It's a Secret to Everybody", Buffer.from("Hello, World?"), signature)).toBe(false);
});

test("takes a missing or malformed webhook signature as wrong, without throwing", () => {
  const body = Buffer.from("Hello, World!");
  for (const header of [undefined, "", "sha256=", "sha256=75", "757107ea", "sha256=\u{1f512}", "x".repeat(10_000)]) {
    expect(validWebhookSignature("It's a Secret to Everybody", body, header), String(header)).toBe(false);
  }
});

test("makes the PKCE challenge of RFC 7636's example", () => {
  expect(codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});
