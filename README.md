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

## Sign-in

The page signs in as a user of a GitHub App and calls api.github.com with that user's access token, which it keeps
only in memory. The relay does the two steps a browser can't, because they need the app's client secret:

1. "Sign in with GitHub" goes to `/api/auth/login`, which sends the browser to GitHub. GitHub sends it back to
   `/api/auth/callback` with a code; the relay trades the code for tokens, puts the refresh token in a cookie and
   goes to the page.
2. The page asks `POST /api/auth/token` for an access token when it loads, and again a few minutes before the token
   runs out (it lasts 8 hours). Each time the relay refreshes at GitHub, which replaces the refresh token too, so
   the cookie is set anew.

The cookie is encrypted (AES-256-GCM), HttpOnly, SameSite=Strict and sent only to `/api/auth`; it lasts as long as
the refresh token, 6 months from the last use. `POST /api/auth/logout` removes it. The relay stores nothing and has
no list of users: the site sits behind Tinyauth at the reverse proxy, which decides who gets as far as signing in.

The relay reads four variables for the sign-in. With none set it runs without sign-in (the endpoints answer 503);
with some missing or wrong it refuses to start. The fifth is for the webhooks (see "Push") and optional on its own.

| Variable                   | Value                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_CLIENT_ID`     | The app's client ID (not its app ID).                                                                   |
| `GITHUB_APP_CLIENT_SECRET` | A client secret generated on the app's page.                                                            |
| `COOKIE_KEY`               | 32 random bytes in base64: `openssl rand -base64 32`. Changing it signs everyone out.                   |
| `PUBLIC_URL`               | Where the browser reaches the relay, `https://github.vorkinn.org`. Cookies are Secure when it is https. |
| `GITHUB_WEBHOOK_SECRET`    | The app's webhook secret: `openssl rand -hex 32`. Without it `/api/github/webhook` answers 503.         |

The GitHub App (Settings, Developer settings, GitHub Apps):

- Callback URL: `https://github.vorkinn.org/api/auth/callback`, plus `http://localhost:5173/api/auth/callback` to
  sign in while developing.
- "Expire user authorization tokens": on. Without it GitHub gives no refresh token and the sign-in fails.
- "Request user authorization (OAuth) during installation": as you like; the page starts the sign-in itself.
- No webhook is needed for signing in; "Push" below sets one up.

To sign in locally, start the relay with the four variables and `PUBLIC_URL=http://localhost:5173`, and open the
page from `npm run dev`: Vite passes `/api` on to the relay, so the browser sees one origin. Without Vite, use
`PUBLIC_URL=http://localhost:8080` (and that callback URL in the app) with `npm run build && npm start`.

## Push

GitHub tells the relay when something changes, and the relay tells the open pages, which then fetch what changed
from api.github.com themselves:

1. GitHub sends the app's webhooks to `POST /api/github/webhook`. The relay checks the signature
   (`X-Hub-Signature-256`, made with the webhook secret) and refuses anything unsigned with 401.
2. Each open page holds `GET /api/events` open, and gets a short notice of every webhook as it arrives.

The relay keeps nothing of this: a notice goes to the pages that are connected at that moment and is then gone. A
page that connects later, or again after a break, is not told what it missed and reads the current state from
GitHub.

On the GitHub App's page, under Webhook:

- Active: ticked.
- Webhook URL: `https://github.vorkinn.org/api/github/webhook`.
- Secret: the same value as `GITHUB_WEBHOOK_SECRET`.

GitHub Apps always send their webhooks as JSON, which is the only form the relay reads.

Under "Subscribe to events", tick the events below. GitHub only offers an event once the app has the permission it
goes with, and a permission added later has to be accepted on the app's installation before its events arrive.

| Event               | Permission it goes with (read is enough) |
| ------------------- | ---------------------------------------- |
| Pull request        | Pull requests                            |
| Pull request review | Pull requests                            |
| Check run           | Checks                                   |
| Check suite         | Checks                                   |
| Status              | Commit statuses                          |
| Workflow run        | Actions                                  |
| Workflow job        | Actions                                  |
| Release             | Contents                                 |
| Push                | Contents                                 |
| Repository          | Metadata (every app has it)              |
| Deployment review   | Deployments                              |

Deployments is the one permission here beyond those the page already needs for its own calls (Actions, Checks,
Commit statuses, Contents, Pull requests). This table is written from GitHub's documentation as remembered, not
checked against the app's page: if an event is missing from the list there, its permission is the thing to look at.

At the reverse proxy, `/api/github/webhook` must be reachable without Tinyauth, since GitHub can't sign in there;
everything else, `/api/events` included, stays behind it. The relay has no list of who may read the stream. The
proxy must also pass the stream on unbuffered and leave it open while idle: the relay sends `X-Accel-Buffering: no`
and a line every 20 seconds for that.

### The event stream

`GET /api/events` answers with `text/event-stream` (Server-Sent Events, what the browser's `EventSource` reads):

```
event: hello
data: {}

event: change
data: {"kind":"pull_request","repo":"nvorkinn/github-dashboard","action":"synchronize","pull":12,"sha":"4f0c..."}

: ping
```

- `hello` comes once, on connecting. A page that sees it after a break knows it may have missed changes.
- `change` comes once per webhook. `kind` is the webhook's event name (`X-GitHub-Event`) and is always there. The
  rest is there when the webhook has it: `repo` (the repository's full name), `action`, `pull` (the pull request's
  number), `sha` (the head commit) and `run` (the workflow run's id). Nothing else from the webhook is passed on.
- `: ping` is a comment line, sent every 20 seconds to keep the connection open. `EventSource` ignores it.

GitHub's own `ping` webhook, sent when the webhook is set up, is answered and not passed on.

To try it locally, with the relay started with `GITHUB_WEBHOOK_SECRET=secret`:

```sh
curl -N localhost:8080/api/events &
body='{"action":"opened","repository":{"full_name":"nvorkinn/github-dashboard"},"pull_request":{"number":1}}'
curl -X POST localhost:8080/api/github/webhook -H "X-GitHub-Event: pull_request" \
  -H "X-Hub-Signature-256: sha256=$(printf %s "$body" | openssl dgst -sha256 -hmac secret -r | cut -d' ' -f1)" \
  -d "$body"
```

## Previews

The demo is the page running on built-in sample data (`web/src/demo.ts`), with no relay, sign-in or GitHub behind it:
it starts signed in as a sample user.
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
