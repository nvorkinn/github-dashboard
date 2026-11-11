import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { readAuthConfig, readTelegramConfig, readWebhookSecret } from "./config.ts";

test("Telegram is optional, and needs both its settings", () => {
  expect(readTelegramConfig({})).toBeUndefined();
  expect(readTelegramConfig({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" })).toBeUndefined();
  expect(readTelegramConfig({ TELEGRAM_BOT_TOKEN: "123:abc-DEF_9", TELEGRAM_CHAT_ID: "-100123" })).toEqual({
    botToken: "123:abc-DEF_9",
    chatId: "-100123",
  });
  expect(readTelegramConfig({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "@my_channel" })?.chatId).toBe(
    "@my_channel",
  );
  expect(() => readTelegramConfig({ TELEGRAM_BOT_TOKEN: "123:abc" })).toThrow(
    "Telegram is half configured: TELEGRAM_CHAT_ID not set",
  );
  expect(() => readTelegramConfig({ TELEGRAM_CHAT_ID: "42" })).toThrow(
    "Telegram is half configured: TELEGRAM_BOT_TOKEN not set",
  );
});

test("refuses Telegram settings in the wrong form, without quoting the token", () => {
  for (const token of ["abc", "123", "123:", "123:abc def", "bot123:abc"]) {
    let message = "";
    try {
      readTelegramConfig({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "42" });
    } catch (error) {
      message = String(error);
    }
    expect(message, token).toContain("TELEGRAM_BOT_TOKEN must be");
    expect(message, token).not.toContain(token);
  }
  for (const chat of ["forty-two", "4 2", "@ab", "https://t.me/x"]) {
    expect(() => readTelegramConfig({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: chat }), chat).toThrow(
      "TELEGRAM_CHAT_ID must be",
    );
  }
});

test("the webhook secret is optional and apart from the sign-in settings", () => {
  expect(readWebhookSecret({})).toBeUndefined();
  expect(readWebhookSecret({ GITHUB_WEBHOOK_SECRET: "" })).toBeUndefined();
  expect(readWebhookSecret({ GITHUB_WEBHOOK_SECRET: "a secret" })).toBe("a secret");
  expect(readAuthConfig({ GITHUB_WEBHOOK_SECRET: "a secret" })).toBeUndefined();
});

const env = {
  GITHUB_APP_CLIENT_ID: "Iv1.client",
  GITHUB_APP_CLIENT_SECRET: "secret",
  COOKIE_KEY: randomBytes(32).toString("base64"),
  PUBLIC_URL: "https://github.vorkinn.org",
};

test("no sign-in when nothing is set", () => {
  expect(readAuthConfig({})).toBeUndefined();
  expect(readAuthConfig({ PORT: "8080", PUBLIC_URL: "" })).toBeUndefined();
});

test("reads a full configuration", () => {
  expect(readAuthConfig(env)).toMatchObject({
    clientId: "Iv1.client",
    clientSecret: "secret",
    publicOrigin: "https://github.vorkinn.org",
    secureCookies: true,
  });
  expect(readAuthConfig({ ...env, PUBLIC_URL: "http://localhost:5173/" })).toMatchObject({
    publicOrigin: "http://localhost:5173",
    secureCookies: false,
  });
});

test("names what a half-set configuration lacks", () => {
  expect(() => readAuthConfig({ ...env, COOKIE_KEY: undefined, PUBLIC_URL: "" })).toThrow("COOKIE_KEY, PUBLIC_URL");
});

test("refuses a cookie key that isn't 32 bytes of base64", () => {
  expect(() => readAuthConfig({ ...env, COOKIE_KEY: randomBytes(16).toString("base64") })).toThrow("COOKIE_KEY");
  expect(() => readAuthConfig({ ...env, COOKIE_KEY: `${"!".repeat(10)}${env.COOKIE_KEY}` })).toThrow("COOKIE_KEY");
});

test("refuses a public address that isn't a bare http(s) origin", () => {
  for (const address of ["github.vorkinn.org", "ftp://github.vorkinn.org", "https://github.vorkinn.org/dashboard"]) {
    expect(() => readAuthConfig({ ...env, PUBLIC_URL: address }), address).toThrow("PUBLIC_URL");
  }
});
