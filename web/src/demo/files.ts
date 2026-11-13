import type { ChangedFile, PullFiles, PullRequest } from "../model.ts";

/**
 * The demo's changed files, so that "Review changes" opens on something: one pull request with a deep tree of many
 * kinds of file, and a few small ones for the rest.
 */

/** A file whose patch is one hunk: `kept` lines, then `removed`, then `added`. */
function changed(
  path: string,
  kept: string[],
  removed: string[],
  added: string[],
  status = removed.length === 0 && kept.length === 0
    ? "added"
    : added.length === 0 && kept.length === 0
      ? "removed"
      : "modified",
  previousPath?: string,
): ChangedFile {
  const before = kept.length + removed.length;
  const after = kept.length + added.length;
  const range = (start: number, count: number) => (count === 0 ? `${start - 1},0` : `${start},${count}`);
  const patch = [
    `@@ -${range(1, before)} +${range(1, after)} @@`,
    ...kept.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
  return { path, previousPath, status, additions: added.length, deletions: removed.length, patch };
}

const WIND_GUSTS: ChangedFile[] = [
  changed(
    ".github/workflows/ci.yml",
    ["jobs:", "  test:", "    runs-on: ubuntu-latest"],
    [],
    ["    timeout-minutes: 10"],
  ),
  changed(
    "README.md",
    ["# Weather station", ""],
    ["Shows temperature and wind."],
    ["Shows temperature, wind and gusts."],
  ),
  changed("firmware/include/wind.h", ["#pragma once", ""], [], ["float gust_speed(const float *samples, int count);"]),
  changed(
    "firmware/src/wind.cpp",
    ['#include "wind.h"', ""],
    [],
    [
      "float gust_speed(const float *samples, int count) {",
      "  float peak = 0;",
      "  for (int i = 0; i < count; i++) peak = samples[i] > peak ? samples[i] : peak;",
      "  return peak;",
      "}",
    ],
  ),
  changed(
    "firmware/platformio.ini",
    ["[env:station]", "board = esp32-c3-devkitm-1"],
    ["build_flags = -O2"],
    ["build_flags = -O2 -DGUSTS"],
  ),
  changed(
    "broker/routes/hourly.py",
    ["def hourly(readings):", "    return {"],
    ['        "wind": average(readings, "wind"),'],
    ['        "wind": average(readings, "wind"),', '        "gusts": peak(readings, "wind"),'],
  ),
  changed("broker/routes/__init__.py", [], [], ["from .hourly import hourly"]),
  changed(
    "broker/templates/hourly.html",
    ["<table>", "  <tr>"],
    ["    <th>Wind</th>"],
    ["    <th>Wind</th>", "    <th>Gusts</th>"],
  ),
  changed(
    "web/src/components/HourlyChart.tsx",
    ["export function HourlyChart({ hours }: { hours: Hour[] }) {", "  return ("],
    ["    <Chart series={[hours.map((h) => h.wind)]} />"],
    ["    <Chart series={[hours.map((h) => h.wind), hours.map((h) => h.gusts)]} dashed={[1]} />"],
  ),
  changed(
    "web/src/components/HourlyChart.test.tsx",
    ['test("draws wind", () => {', "  render(<HourlyChart hours={HOURS} />);"],
    [],
    ['  expect(screen.getByLabelText("Gusts")).toBeTruthy();'],
  ),
  changed("web/src/components/HourlyChart.css", [".hourly-chart {", "  display: grid;"], [], ["  --gust: #f5a524;"]),
  changed("web/src/model.ts", ["export type Hour = {", "  wind: number;"], [], ["  gusts: number;"]),
  changed("web/public/icons/gust.svg", [], [], ['<svg viewBox="0 0 16 16"><path d="M1 8h10a3 3 0 1 0-3-3"/></svg>']),
  changed("web/src/legacy/old_chart.js", [], ["export function drawChart() {}"], []),
  changed(
    "web/src/units.ts",
    ["export const KMH = 3.6;"],
    [],
    ["export const KNOTS = 1.944;"],
    "renamed",
    "web/src/conversions.ts",
  ),
  changed("package.json", ['  "dependencies": {'], ['    "chart-kit": "2.1.0"'], ['    "chart-kit": "2.2.0"']),
  changed("Dockerfile", ["FROM node:24-alpine", "WORKDIR /app"], [], ["ENV GUSTS=1"]),
  changed("docs/wind.md", ["# Wind", ""], [], ["Gusts are the highest reading in each hour."]),
];

const SMALL: ChangedFile[] = [
  changed("README.md", [], [], ["# Recipe box", "", "Recipes, scaled to the servings you need."]),
];

const DEPENDENCY: ChangedFile[] = [
  changed("package.json", ['  "devDependencies": {'], ['    "vite": "8.3.6"'], ['    "vite": "8.3.7"']),
  changed(
    "package-lock.json",
    ['    "node_modules/vite": {'],
    ['      "version": "8.3.6"'],
    ['      "version": "8.3.7"'],
  ),
];

/** The demo's answer to reading a pull request's files. */
export async function demoFiles(pull: PullRequest): Promise<PullFiles> {
  const files = pull.number === 128 ? WIND_GUSTS : pull.number === 131 ? DEPENDENCY : SMALL;
  return { files, truncated: false };
}
