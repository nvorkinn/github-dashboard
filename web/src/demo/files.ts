import type { ChangedFile, FileImage, FileSide, PullFiles, PullRequest } from "../model.ts";

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

const GUST_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 16 16"><path d="M1 8h10a3 3 0 1 0-3-3M1 11h6a2 2 0 1 1-2 2" fill="none" stroke="#38bdf8" stroke-width="1.5" stroke-linecap="round"/></svg>';

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
  changed("web/public/icons/gust.svg", [], [], [GUST_SVG]),
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
  // Binary files: GitHub gives no patch and counts no lines for them.
  { path: "docs/wind-chart.png", previousPath: undefined, status: "modified", additions: 0, deletions: 0 },
  { path: "web/public/icons/sunny.png", previousPath: undefined, status: "removed", additions: 0, deletions: 0 },
  { path: "firmware/data/calibration.bin", previousPath: undefined, status: "modified", additions: 0, deletions: 0 },
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

/** A sample chart as an SVG `data:` address: wind as a blue line, and with `gusts` an orange one above it. */
function chart(gusts: boolean, width = 480, height = 270): string {
  const wind = [40, 52, 47, 61, 58, 70, 66, 74, 69];
  const step = (width - 60) / (wind.length - 1);
  const line = (values: number[]) =>
    values.map((value, i) => `${i ? "L" : "M"}${30 + i * step},${height - 30 - value * 2.2}`).join(" ");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="10" y="10" width="${width - 20}" height="${height - 20}" rx="12" fill="#f4f6fb"/>`,
    `<path d="M30 ${height - 30} H${width - 30}" stroke="#9aa3b5" stroke-width="2"/>`,
    `<path d="${line(wind)}" fill="none" stroke="#3b82f6" stroke-width="4"/>`,
    gusts ? `<path d="${line(wind.map((v) => v + 18))}" fill="none" stroke="#f97316" stroke-width="4"/>` : "",
    `<text x="30" y="38" font-family="sans-serif" font-size="18" fill="#334">${gusts ? "Wind and gusts" : "Wind"}</text>`,
    "</svg>",
  ].join("");
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** A sample icon: a sun, on a transparent background. */
function icon(): string {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">',
    '<circle cx="54" cy="54" r="30" fill="#facc15"/>',
    "</svg>",
  ].join("");
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const DEMO_IMAGES: Record<string, { before?: string; after?: string }> = {
  "docs/wind-chart.png": { before: chart(false), after: chart(true, 560, 300) },
  "web/public/icons/gust.svg": { after: `data:image/svg+xml;base64,${btoa(GUST_SVG)}` },
  "web/public/icons/sunny.png": { before: icon() },
};

/** The demo's answer to reading a side of a changed image. */
export async function demoImage(_pull: PullRequest, file: ChangedFile, side: FileSide): Promise<FileImage> {
  const url = DEMO_IMAGES[file.path]?.[side];
  if (!url) throw new Error("The demo has no such image.");
  return { url, bytes: Math.round(((url.length - url.indexOf(",") - 1) * 3) / 4) };
}
