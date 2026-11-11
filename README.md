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
npm run check   # Biome (lint, format, imports) and the type check
npm test        # Vitest
```

`docker build -t github-dashboard .` builds the image that gets deployed; it listens on `PORT` (8080).

## Pull requests

`main` takes changes only through pull requests, and requires one check, "Global PR Status". The All checks workflow
completes it once every other workflow on the commit has passed; a new workflow that runs on pull requests has to be
added to its list (`tests/workflows.test.ts` fails until it is).
