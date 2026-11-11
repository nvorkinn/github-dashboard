import type { Check, CheckState, DashboardData, Job, Project, PullRequest, ReleaseRun } from "../model.ts";
import { AVATARS } from "./avatars.ts";

/**
 * The demo's sample data: one of every case the page can draw. Most of it stands still; one pull request's checks
 * and one release run follow a script, a frame at a time, so the preview shows the page updating by itself.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The script's length. The last frames hold the finished state before it starts over. */
export const FRAMES = 14;
/** Where the script starts: in the middle, with something in every state. */
export const FIRST_FRAME = 5;
// How much time a frame stands for in the story, which runs faster than the clock.
const FRAME_STORY_MS = 45_000;

const OWNER = "octocat";
const github = (path: string) => `https://github.com/${OWNER}/${path}`;

type Login = keyof typeof AVATARS;

/** One scripted step: not started before `from`, under way until `to`, done from then on. */
type Step = { name: string; from: number; to: number; waits?: boolean };

function stepState(step: Step, frame: number): CheckState {
  if (frame < step.from) {
    return "queued";
  }
  if (frame >= step.to) {
    return "passed";
  }
  return step.waits ? "waiting" : "running";
}

const PULL_STEPS: Step[] = [
  { name: "lint", from: 0, to: 1 },
  { name: "typecheck", from: 0, to: 2 },
  { name: "unit tests", from: 1, to: 4 },
  { name: "build", from: 2, to: 5 },
  { name: "e2e (chromium)", from: 5, to: 8 },
  { name: "e2e (firefox)", from: 5, to: 9 },
  { name: "preview", from: 9, to: 10 },
  { name: "Global PR Status", from: 10, to: 11 },
];

const RELEASE_STEPS: Step[] = [
  { name: "version", from: 0, to: 1 },
  { name: "build (amd64)", from: 1, to: 3 },
  { name: "build (arm64)", from: 1, to: 4 },
  { name: "smoke test", from: 4, to: 5 },
  { name: "deploy dev", from: 5, to: 7 },
  { name: "approve-prod", from: 5, to: 8, waits: true },
  { name: "deploy prod", from: 8, to: 10 },
  { name: "publish release", from: 10, to: 11 },
];
const RELEASE_DONE = 11;

/**
 * Everything on the page. `base` is when the demo started, which the still parts are dated from; `frame` is the
 * script's place and `frameAt` when it got there.
 */
export function sampleData(at: { base: number; frame: number; frameAt: number }): DashboardData {
  const { base, frame, frameAt } = at;
  const iso = (ms: number) => new Date(ms).toISOString();
  const before = (ms: number) => iso(base - ms);
  // When the scripted push and release began, counted back from the frame in story time.
  const storyStart = frameAt - frame * FRAME_STORY_MS - 20_000;
  const storyAt = (atFrame: number) => iso(storyStart + atFrame * FRAME_STORY_MS);

  const projects: Project[] = [
    {
      repo: `${OWNER}/weather-station`,
      name: "weather-station",
      description: "Reads the roof sensors and draws the charts",
      url: github("weather-station"),
      defaultBranch: "main",
      private: false,
      pushedAt: before(12 * MINUTE),
      latestRelease: {
        tag: "v2.4.1",
        url: github("weather-station/releases/tag/v2.4.1"),
        publishedAt: before(3 * DAY),
      },
    },
    {
      repo: `${OWNER}/trail-maps`,
      name: "trail-maps",
      description: "Offline hiking maps",
      url: github("trail-maps"),
      defaultBranch: "main",
      private: false,
      pushedAt: before(5 * HOUR),
      latestRelease: { tag: "v0.9.0", url: github("trail-maps/releases/tag/v0.9.0"), publishedAt: before(23 * DAY) },
    },
    {
      repo: `${OWNER}/home-ledger`,
      name: "home-ledger",
      description: "Household bookkeeping",
      url: github("home-ledger"),
      defaultBranch: "main",
      private: true,
      pushedAt: before(26 * HOUR),
      latestRelease: {
        tag: "v1.12.3",
        url: github("home-ledger/releases/tag/v1.12.3"),
        publishedAt: before(26 * HOUR),
      },
    },
    {
      repo: `${OWNER}/recipe-box`,
      name: "recipe-box",
      description: undefined,
      url: github("recipe-box"),
      defaultBranch: "trunk",
      private: false,
      pushedAt: before(9 * DAY),
      latestRelease: undefined,
    },
    {
      repo: `${OWNER}/garden-sensors`,
      name: "garden-sensors",
      description: "Firmware and gateway for the soil moisture probes",
      url: github("garden-sensors"),
      defaultBranch: "main",
      private: false,
      pushedAt: before(40 * MINUTE),
      latestRelease: {
        tag: "v3.0.0-rc.2",
        url: github("garden-sensors/releases/tag/v3.0.0-rc.2"),
        publishedAt: before(6 * DAY),
      },
    },
  ];

  function pull(
    repo: string,
    number: number,
    title: string,
    author: Login,
    rest: Partial<PullRequest> & { opened: number; updated: number },
  ): PullRequest {
    const { opened, updated, ...fields } = rest;
    return {
      repo: `${OWNER}/${repo}`,
      number,
      title,
      url: github(`${repo}/pull/${number}`),
      author,
      authorAvatarUrl: AVATARS[author],
      draft: false,
      head: `${author}/patch-${number}`,
      base: "main",
      sha: number.toString(16).padStart(7, "0"),
      createdAt: before(opened),
      updatedAt: before(updated),
      mergeState: "clean",
      autoMerge: false,
      checks: [],
      ...fields,
    };
  }

  const checksOf = (repo: string, number: number, states: [string, CheckState][]): Check[] =>
    states.map(([name, state]) => ({ name, state, url: github(`${repo}/pull/${number}/checks`) }));
  const passed = (...names: string[]): [string, CheckState][] => names.map((name) => [name, "passed"]);

  const scriptedChecks = PULL_STEPS.map((step) => ({
    name: step.name,
    state: stepState(step, frame),
    url: github("weather-station/pull/128/checks"),
  }));
  const scriptedDone = scriptedChecks.every((check) => check.state === "passed");

  const pulls: PullRequest[] = [
    pull("weather-station", 128, "Show wind gusts on the hourly chart", "monalisa", {
      head: "monalisa/wind-gusts",
      opened: 2 * HOUR,
      updated: 0,
      updatedAt: iso(storyStart),
      // Required checks stand in the way until the last of them is through.
      mergeState: scriptedDone ? "clean" : "blocked",
      autoMerge: true,
      checks: scriptedChecks,
    }),
    pull("weather-station", 131, "Bump vite from 8.3.6 to 8.3.7", "dependabot[bot]", {
      head: "dependabot/npm_and_yarn/vite-8.3.7",
      opened: 7 * HOUR,
      updated: 7 * HOUR,
      autoMerge: true,
      checks: checksOf("weather-station", 131, passed("lint", "typecheck", "unit tests", "build", "Global PR Status")),
    }),
    pull("trail-maps", 57, "Cache tiles for offline use", "hubot", {
      head: "hubot/tile-cache",
      opened: 4 * DAY,
      updated: 50 * MINUTE,
      mergeState: "blocked",
      checks: checksOf("trail-maps", 57, [
        ...passed("lint", "typecheck", "unit (node 22)", "unit (node 24)", "build (web)", "build (android)"),
        ["build (ios)", "failed"],
        ["e2e (chromium)", "failed"],
        ...passed("e2e (firefox)", "e2e (webkit)"),
        ["bundle size", "neutral"],
        ["preview", "skipped"],
        ["licence scan", "passed"],
        ["Global PR Status", "failed"],
      ]),
    }),
    pull(
      "trail-maps",
      61,
      "Rework the elevation profile so that it keeps its scale when zooming, labels every 100 m contour and no longer redraws the whole track on each pan",
      "octocat",
      {
        head: "octocat/elevation-profile-keeps-scale-and-labels-contours-without-full-redraw",
        base: "release/0.10-elevation-and-offline-improvements",
        opened: 9 * DAY,
        updated: 2 * DAY,
        mergeState: "behind",
        checks: checksOf("trail-maps", 61, passed("lint", "typecheck", "unit (node 24)", "build (web)")),
      },
    ),
    pull("home-ledger", 212, "Import bank statements in CAMT.053", "octocat", {
      draft: true,
      head: "octocat/camt-import",
      opened: 30 * HOUR,
      updated: 3 * HOUR,
      mergeState: "blocked",
      checks: checksOf("home-ledger", 212, [...passed("lint", "unit tests"), ["migrations", "queued"]]),
    }),
    pull("home-ledger", 209, "Split shared expenses by weight", "defunkt", {
      head: "defunkt/weighted-split",
      opened: 16 * DAY,
      updated: 6 * DAY,
      mergeState: "conflicts",
      checks: checksOf("home-ledger", 209, passed("lint", "unit tests", "migrations")),
    }),
    pull("recipe-box", 9, "Add a README", "monalisa", {
      base: "trunk",
      opened: 20 * MINUTE,
      updated: 20 * MINUTE,
      mergeState: "unknown",
    }),
    pull("recipe-box", 7, "Scale ingredients by servings", "defunkt", {
      head: "defunkt/servings",
      base: "trunk",
      opened: 70 * DAY,
      updated: 12 * DAY,
      mergeState: "blocked",
      checks: checksOf("recipe-box", 7, [
        ["test", "cancelled"],
        ["lint", "passed"],
        ["deploy preview", "skipped"],
      ]),
    }),
    pull("garden-sensors", 340, "Flash the greenhouse rig from the pull request", "hubot", {
      head: "hubot/flash-from-pr",
      opened: 95 * MINUTE,
      updated: 14 * MINUTE,
      mergeState: "blocked",
      checks: checksOf("garden-sensors", 340, [
        ...passed("build firmware", "unit tests", "gateway tests"),
        ["flash rig (greenhouse)", "waiting"],
        ["hardware-in-the-loop", "queued"],
      ]),
    }),
    pull("garden-sensors", 338, "Calibrate soil moisture probes per bed", "octocat", {
      head: "octocat/per-bed-calibration",
      opened: 2 * DAY,
      updated: 4 * HOUR,
      checks: checksOf(
        "garden-sensors",
        338,
        passed("build firmware", "unit tests", "gateway tests", "hardware-in-the-loop"),
      ),
    }),
  ];

  /** A job that ran from `start` for `took`, both counted back from the demo's start. */
  function job(repo: string, id: number, name: string, state: CheckState, start?: number, took?: number): Job {
    return {
      id,
      name,
      state,
      url: github(`${repo}/actions/runs/${Math.floor(id / 100)}/job/${id}`),
      startedAt: start === undefined ? undefined : before(start),
      finishedAt: start === undefined || took === undefined ? undefined : before(start - took),
    };
  }

  const releaseOver = frame >= RELEASE_DONE;
  const scriptedJobs: Job[] = RELEASE_STEPS.map((step, index) => {
    const state = stepState(step, frame);
    return {
      id: 907100 + index,
      name: step.name,
      state,
      url: github(`weather-station/actions/runs/9071/job/${907100 + index}`),
      // An approval takes no time of its own worth showing.
      startedAt: state === "queued" || step.waits ? undefined : storyAt(step.from),
      finishedAt: state === "passed" && !step.waits ? storyAt(step.to) : undefined,
    };
  });
  scriptedJobs.push({
    id: 907199,
    name: "notify",
    state: "skipped",
    url: undefined,
    startedAt: undefined,
    finishedAt: undefined,
  });
  const scriptedStates = new Set(scriptedJobs.map((one) => one.state));

  const releases: ReleaseRun[] = [
    {
      repo: `${OWNER}/weather-station`,
      id: 9071,
      workflow: "Release",
      title: "v2.5.0",
      url: github("weather-station/actions/runs/9071"),
      state: releaseOver ? "passed" : scriptedStates.has("running") ? "running" : "waiting",
      actor: "octocat",
      startedAt: iso(storyStart),
      finishedAt: releaseOver ? storyAt(RELEASE_DONE) : undefined,
      jobs: scriptedJobs,
    },
    {
      repo: `${OWNER}/weather-station`,
      id: 8893,
      workflow: "Release",
      title: "v2.4.1",
      url: github("weather-station/actions/runs/8893"),
      state: "passed",
      actor: "octocat",
      startedAt: before(3 * DAY + 9 * MINUTE),
      finishedAt: before(3 * DAY),
      jobs: [
        job("weather-station", 889301, "version", "passed", 3 * DAY + 9 * MINUTE, 14_000),
        job("weather-station", 889302, "build (amd64)", "passed", 3 * DAY + 8 * MINUTE, 96_000),
        job("weather-station", 889303, "build (arm64)", "passed", 3 * DAY + 8 * MINUTE, 171_000),
        job("weather-station", 889304, "smoke test", "passed", 3 * DAY + 5 * MINUTE, 38_000),
        job("weather-station", 889305, "deploy dev", "passed", 3 * DAY + 4 * MINUTE, 52_000),
        job("weather-station", 889306, "approve-prod", "passed", 3 * DAY + 3 * MINUTE, 2000),
        job("weather-station", 889307, "deploy prod", "passed", 3 * DAY + 2 * MINUTE, 61_000),
        job("weather-station", 889308, "publish release", "passed", 3 * DAY + MINUTE, 22_000),
        job("weather-station", 889309, "notify", "skipped"),
      ],
    },
    {
      repo: `${OWNER}/garden-sensors`,
      id: 4410,
      workflow: "Release firmware",
      title: "v3.0.0-rc.3",
      url: github("garden-sensors/actions/runs/4410"),
      state: "failed",
      actor: "hubot",
      startedAt: before(46 * MINUTE),
      finishedAt: before(40 * MINUTE),
      jobs: [
        job("garden-sensors", 441001, "version", "passed", 46 * MINUTE, 11_000),
        job("garden-sensors", 441002, "build (esp32-c6)", "passed", 45 * MINUTE, 143_000),
        job("garden-sensors", 441003, "build (esp32-s3)", "failed", 45 * MINUTE, 204_000),
        job("garden-sensors", 441004, "build gateway", "cancelled", 45 * MINUTE, 210_000),
        job("garden-sensors", 441005, "sign", "skipped"),
        job("garden-sensors", 441006, "publish release", "skipped"),
      ],
    },
    {
      repo: `${OWNER}/home-ledger`,
      id: 2764,
      workflow: "Deploy",
      title: "Deploy v1.12.3 to production",
      url: github("home-ledger/actions/runs/2764"),
      state: "passed",
      actor: "octocat",
      startedAt: before(26 * HOUR),
      finishedAt: before(26 * HOUR - 4 * MINUTE - 37_000),
      jobs: [
        job("home-ledger", 276401, "build image", "passed", 26 * HOUR, 118_000),
        job("home-ledger", 276402, "migrate database", "passed", 26 * HOUR - 2 * MINUTE, 41_000),
        job("home-ledger", 276403, "deploy", "passed", 26 * HOUR - 3 * MINUTE, 64_000),
        job("home-ledger", 276404, "health check", "passed", 26 * HOUR - 4 * MINUTE, 37_000),
      ],
    },
  ];

  return { projects, pulls, releases };
}

/** What `?show=empty` shows: a signed-in user with nothing yet. */
export const NOTHING: DashboardData = { projects: [], pulls: [], releases: [] };
