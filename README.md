# GitHub dashboard

A live dashboard of Nikolai's GitHub projects: pull requests, checks and release workflows, updated by push from GitHub's
webhooks. The browser talks to api.github.com itself; a small relay only signs in to the GitHub App, refreshes its token
and passes webhook events on to the open page.

It replaces the dashboard inside countdown-server once it does everything that one does.

## Layout

- `web/`: the page, Preact and TypeScript, built by Vite into `dist/web`.
- `relay/`: the relay, TypeScript that Node runs as it is (no compile step). It serves the built page.
- `tests/`: checks on the repository itself, such as the CI workflows.

## Working on it

Needs Node 24 (`.node-version`).

```sh
npm ci
npm run build   # build the page into dist/web
npm start       # the relay on http://localhost:8080, serving the built page
npm run dev     # or: Vite's dev server for the page, passing /api and /healthz to the relay
npm run build:demo  # the demo: the page on sample data, into dist/demo
npm run check   # Biome (lint, format, imports) and the type check
npm test        # Vitest
```

`docker build -t github-dashboard .` builds the image that gets deployed; it listens on `PORT` (8080).

## Previews

The demo is the page running on built-in sample data (`web/src/demo.ts`), with no relay, sign-in or GitHub behind it.
The Preview workflow publishes it to GitHub Pages from the `gh-pages` branch:

- each pull request's at `https://nvorkinn.github.io/github-dashboard/pr-<number>/`, linked from the pull request as
  a deployment ("View deployment"), and removed when the pull request closes;
- main's at `https://nvorkinn.github.io/github-dashboard/`.

When the page learns something new to show, give the demo sample data for it, so the preview shows it too. Pull
requests from forks and from Dependabot get no preview.

## Releases

Press **Run workflow** on the Release workflow (Actions > Release) and pick the bump: patch, minor or major. It tags the
head of `main` with the next version after the latest `v*` tag (with no tag yet, patch gives `v0.0.1` and minor
`v0.1.0`), builds the image for amd64 and arm64, starts each to check it serves the page, and then publishes:

- the image, as `ghcr.io/nvorkinn/github-dashboard:<tag>` (the tag as it is, `v` included) and `:latest`;
- a GitHub Release for the tag, with the image's digest and the notes GitHub generates.

Pushing a `v*` tag by hand does the same for that tag. Nothing is deployed from here: home-stack pins the image by tag
and digest (`ghcr.io/nvorkinn/github-dashboard:v0.1.0@sha256:...`, the line the run's summary and the release show), so
a release reaches the server when that pin is moved.

## Pull requests

`main` takes changes only through pull requests, and requires one check, "Global PR Status". The All checks workflow
completes it once every other workflow on the commit has passed; a new workflow that runs on pull requests has to be
added to its list (`tests/workflows.test.ts` fails until it is).
