import { expect, test } from "vitest";
import { ago, countdown, duration } from "./time.ts";

const NOW = Date.parse("2026-03-01T12:00:00Z");
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

test("says how long ago in one unit", () => {
  const cases: [number, string][] = [
    [0, "just now"],
    [4 * S, "just now"],
    [12 * S, "12s ago"],
    [59 * S, "59s ago"],
    [60 * S, "1m ago"],
    [59 * M + 59 * S, "59m ago"],
    [3 * H, "3h ago"],
    [2 * D, "2d ago"],
    [13 * D, "13d ago"],
    [21 * D, "3w ago"],
    [70 * D, "2mo ago"],
    [800 * D, "2y ago"],
  ];
  for (const [elapsed, words] of cases) {
    expect(ago(NOW - elapsed, NOW)).toBe(words);
  }
});

test("takes GitHub's ISO strings", () => {
  expect(ago("2026-03-01T11:58:00Z", NOW)).toBe("2m ago");
});

test("counts a time ahead of this clock as now, and has no words for what isn't a time", () => {
  expect(ago(NOW + 30 * S, NOW)).toBe("just now");
  expect(ago("soon", NOW)).toBe("");
});

test("gives a duration in its two largest units", () => {
  expect(duration(0)).toBe("0s");
  expect(duration(42 * S + 900)).toBe("42s");
  expect(duration(4 * M + 12 * S)).toBe("4m 12s");
  expect(duration(H + 5 * M + 30 * S)).toBe("1h 5m");
  expect(duration(2 * D + 3 * H)).toBe("2d 3h");
  expect(duration(-5 * S)).toBe("0s");
});

test("counts down in minutes and seconds", () => {
  expect(countdown(5 * M)).toBe("5:00");
  expect(countdown(3 * M + 11 * S + 1)).toBe("3:12");
  expect(countdown(9 * S)).toBe("0:09");
  expect(countdown(-S)).toBe("0:00");
});
