# GitHub dashboard

A live dashboard of Nikolai's GitHub projects: pull requests, checks and release workflows, updated by push from GitHub's
webhooks. The browser talks to api.github.com itself; a small relay only signs in to the GitHub App, refreshes its token
and passes webhook events on to the open page.

It replaces the dashboard inside countdown-server once it does everything that one does.

## Layout

- `web/`: the page, Preact and TypeScript, built by Vite into `dist/web`.
  The diff's file and folder icons are from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme)
  (MIT), a chosen few listed in `web/src/components/file_icons.ts`.
- `web/public/`: files copied into the build as they are: the favicon (`favicon.svg`, with `favicon.ico` and
  `apple-touch-icon.png` rendered from it for browsers and home screens that don't take SVG).
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
   runs out (it lasts 8 hours). The relay refreshes at GitHub, which replaces the refresh token too, so the cookies
   are set anew. It doesn't for a page that only loaded again: the access token is in a cookie of its own, and while
   it has more than ten minutes left the relay hands that one out, with no call to GitHub. A page whose token GitHub
   refuses asks with `?fresh=1`, which always refreshes.

Both cookies are encrypted (AES-256-GCM), HttpOnly, SameSite=Strict and sent only to `/api/auth`. The refresh
token's lasts as long as the token, 6 months from the last use; the access token's as long as its token, 8 hours.
The page's scripts can read neither, and the page keeps the access token only in memory.
`POST /api/auth/logout` removes both. The relay stores nothing and has
no list of users: the site sits behind Tinyauth at the reverse proxy, which decides who gets as far as signing in.

The relay reads four variables for the sign-in. With none set it runs without sign-in (the endpoints answer 503);
with some missing or wrong it refuses to start. The fifth is for the webhooks (see "Push") and optional on its own,
as are the two for Telegram (see "Telegram").

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
- Repository permissions: Actions write, Checks read, Commit statuses read, Contents write, Deployments write,
  Metadata read, Pull requests write; and Workflows write, needed only when a release points at a commit that changes
  workflow files. The page acts as the signed-in user, so the user needs the same access to the repository.
  Repository configuration additionally needs Administration write access; accept the changed permissions on the
  installation after updating the GitHub App. Repository configuration is read only for non-administrators.

What each write is for (reading needs only read access to the same):

| Permission (write) | Buttons that need it                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Administration     | Repository settings and copying branch rules (Workspace → select a repository → Settings) |
| Actions            | Re-run failed jobs and Re-run on a release run; Promote (starts the Promote workflow)     |
| Contents           | Release (writes the notes and publishes); Merge on a pull request                         |
| Deployments        | Approve and Reject on a run waiting for an environment (the user must be its reviewer)    |
| Pull requests      | Auto-merge and Update branch on a pull request                                            |

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

The app has all of these permissions already for the page's own calls (see "Sign-in"). If an event is missing from the
list on the app's page, its permission is the thing to look at.

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
  number), `sha` (the head commit), `run` (the workflow run's id) and `path` (that run's workflow file, which a
  `workflow_run` carries). Nothing else from the webhook is passed on in a `change`.
- `notice` comes after the `change` of a webhook that needs attention, the same ones Telegram is told about (see
  "Telegram"), for the page's desktop notifications (see "Desktop notifications"):
  `{"type":"merged","key":"merged:owner/name#7","repo":"owner/name","headline":"Merged owner/name#7: its title","url":"https://github.com/owner/name/pull/7"}`.
  `type` is `merged`, `changes`, `checks`, `release` or `waiting`, and `key` tells a repeat (GitHub delivering again,
  another failed check on the same commit), which the page then doesn't show twice.
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

## Release workflows

The dashboard shows the runs of a repository's release workflows, not of every workflow. GitHub has no tags or
categories for workflows, so a workflow is marked as a release in its own file, with a comment line anywhere in it:

```yaml
name: Release
# dashboard: release
```

The page reads the mark from the files in `.github/workflows` on the default branch (only the files directly in it). A repository that marks none of
its workflows goes by their names instead: the ones that say release, promote or deploy. Once one file is marked,
names no longer count there. A workflow GitHub runs by itself, such as "pages build and deployment", has no file and
is never shown.

## Reading GitHub

Everything on the page is read through GitHub's GraphQL API (`web/src/github/graphql.ts`), in a handful of requests
sent side by side: at the start, on **Refresh**, every minute while the relay's events don't arrive, and every five
minutes while they do. In between,
an event from the relay reads only what it names, through the REST API (`web/src/github/read.ts`): the pull request,
or the workflow run, and of a run only if its workflow file is one of the project's release workflows. Both end in the
same code, so a pull request reads the same either way.

A read asks for every repository the signed-in user reaches (what its row shows), and for the pull requests, checks,
workflow files and release runs of the projects that aren't hidden. GitHub answers the parts of one query one after
another, so the read is one request for the list and one for every seven projects and every seven release
workflows, all at once: about five requests and a second and a half for a dozen projects, where a single request
took six seconds. A release run is on the page while it is going and for five minutes after, so that is all that is read
of it: of each release workflow whether its latest runs finished and the latest as its card shows it, and of a run
that is going, asked for by itself after, its jobs, pending approvals and workflow file. A finished run shows
without its jobs, with a link to it on GitHub. Of a hidden project nothing
but its row is read; showing it again reads it. A new repository is in the list of the next read, and so shows on
the page by itself, within those one to five minutes or at once when GitHub's `repository` event arrives.

GraphQL has no list of a repository's workflows: a workflow is asked for by its file, so the page has to know the
release workflows' files before it asks. It learns them from each read and keeps them in the browser's local storage
(names of projects and of workflow files, nothing else), which is what lets a reload ask for everything at once as well. A first
visit asks in three rounds, and a read that finds a new project, a new release workflow or a changed workflow file asks once
or twice more for just that. More than 50 open pull requests in a project, 100 checks on a pull request or 100 jobs
in a run don't fit into the answer and are read through the REST API.

GraphQL counts against its own rate limit, 5,000 points an hour, and a read costs about one point per two shown
projects. It doesn't say when a later attempt of a run started, so a run that was re-run shows the time it was first
started.

## Telegram

When nobody is looking at the dashboard, the relay sends a short message to a Telegram chat about the webhooks that
need attention, with a link to the thing on github.com and, when `PUBLIC_URL` is set, to the dashboard:

| What happened                                                                        | Message                                                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| A pull request merged                                                                | `Merged owner/name#7: its title`                             |
| A review requested changes                                                           | `Changes requested on owner/name#7: its title`               |
| A check run or suite on a pull request's commit failed, timed out or wants an action | `Checks failed in owner/name`, with each pull request's link |
| A release run finished (a workflow whose name says release, promote or deploy)       | `Release in owner/name: success` (or how else it ended)      |
| A release run asks for a deployment to be approved (a `deployment_review` request)   | `A release in owner/name is waiting for your approval`       |

The last comes with a "Review in GitHub" button that opens the run, where Review deployments approves it. Everything
else, such as checks passing or a pull request opening, sends nothing.

The relay holds no token, so it can't read the mark in a workflow's file and goes by the workflow's name here, even
in a repository that marks its release workflows.

It stays quiet while a page is open: a message goes only when no page has had `/api/events` open for the last 30
seconds, so a reload, a brief reconnect or a restart of the relay sends nothing. An open page shows it already.

Each message goes once. A webhook GitHub delivers again, a second failed check on the same commit, or a release
asking for the same review again, send nothing more. For that the relay remembers which messages it sent (what they were
about, not what they said), the last 500 of them for 24 hours at most, in memory: a restart forgets them, and then a
repeat can get through once. A send that fails is logged with Telegram's status code, and the webhook is answered all
the same.

| Variable             | Value                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN` | The bot's token, `123456789:AA...`. It is a secret: keep it with the others.           |
| `TELEGRAM_CHAT_ID`   | The chat the bot writes to: its number (negative for a group), or a channel's `@name`. |

Both or neither: with neither the relay sends nothing, and with one, or either in the wrong form, it refuses to
start. Messages also need the webhooks set up (see "Push").

To set it up:

1. In Telegram, talk to [@BotFather](https://t.me/BotFather), send `/newbot` and follow it. It answers with the
   token.
2. Send your new bot any message (a bot can't write to someone who hasn't), or add it to the group it should write in.
3. Open `https://api.telegram.org/bot<token>/getUpdates` in a browser: `"chat":{"id":...}` in the answer is the chat
   id.

## Desktop notifications

While the dashboard is open, what Telegram would be told shows instead as a notification from the browser, which on a
Mac lands in Notification Center. Clicking one opens the thing on github.com. They are the two halves of one thing:
an open page keeps its event stream in a background tab, while Telegram takes over 30 seconds after every page is
closed or the browser suspends their connections.

**Settings** in the header (`#settings`) asks the browser for its permission, sends a test, and picks which of the five
kinds show: a pull request merged, changes requested, checks failed, a release finished, a release waiting for
approval. The choice is kept in the browser's local storage, like the hidden projects, and a hidden project's notices
show nothing. It doesn't change what goes to Telegram. If nothing shows on a Mac, look at System Settings,
Notifications, for the browser, and at Focus.

## Previews

The demo is the page running on built-in sample data (`web/src/demo.ts` for the sign-in, `web/src/demo/` for the
dashboard), with no relay, sign-in or GitHub behind it: it starts signed in as a sample user. One pull request's
checks and one release run follow a script that moves every few seconds and then starts over, so the page can be
seen updating. Adding `?show=problem`, `?show=failed`, `?show=empty`, `?show=loading` or `?show=offline` (the event
stream is down) to the address holds the demo in a state the script never reaches.
The Preview workflow publishes it to GitHub Pages from the `gh-pages` branch:

- each pull request's at `https://nvorkinn.github.io/github-dashboard/pr-<number>/`, linked from the pull request as
  a deployment ("View deployment"), and removed when the pull request closes;
- main's at `https://nvorkinn.github.io/github-dashboard/`.

When the page learns something new to show, give the demo sample data for it, so the preview shows it too. Pull
requests from forks and from Dependabot get no preview.

## Deploys and releases

Every push to `main` (other than to Markdown files) runs the Release workflow, which builds and checks the image as below,
publishes it as `ghcr.io/nvorkinn/github-dashboard:main`, and starts home-stack's Deploy workflow. home-stack runs
`:main` and pulls it on every deploy, so merging is the deploy. Starting the workflow needs the repository secret
`HOME_STACK_DEPLOY_TOKEN`: a fine-grained token for `nvorkinn/home-stack` only, with _Actions: read and write_.

Versioned releases are optional. Press **Run workflow** on the Release workflow (Actions > Release) and pick the bump: patch, minor or major. It tags the
head of `main` with the next version after the latest `v*` tag (with no tag yet, patch gives `v0.0.1` and minor
`v0.1.0`), builds the image for amd64, starts it to check it serves the page, and then publishes:

- the image, as `ghcr.io/nvorkinn/github-dashboard:<tag>` (the tag as it is, `v` included) and `:latest`;
- a GitHub Release for the tag, with the image's digest and the notes GitHub generates.

Pushing a `v*` tag by hand does the same for that tag. A release deploys nothing; the server keeps running `:main`.

## Pull requests

`main` takes changes only through pull requests, and requires one check, "Global PR Status". The All checks workflow
completes it once every other workflow on the commit has passed; a new workflow that runs on pull requests has to be
added to its list (`tests/workflows.test.ts` fails until it is).

### Repository configuration

In **Workspace**, select a repository and open its **Settings** tab. This compact panel is separate from the
pull request review overlay. It reads current values with `GET /repos/{owner}/{repo}` and saves only the changed
field with `PATCH`: deleting branches after merging, auto-merge, and the three merge methods. Unknown values are
unavailable, and at least one merge method must remain enabled. Administrator access is checked again before writes;
GitHub remains the authority on App permissions, repository plans, and organization policy.

**Copy Branch Rules** lists repositories accessible through the signed-in user's GitHub App installations, excluding
the target. Preview reads all pages of classic protection rules through GraphQL (including wildcard patterns), and
fetches full repository rulesets through REST, including inherited rules for context. The comparison shows additions,
replacements and unchanged target rules. Nothing is selected automatically. Expand each comparison to review its
current and proposed values, select individual changes, then explicitly confirm the destination before applying.
Only matching classic patterns or repository rulesets with matching names and targets can be replaced; other target
rules and inherited rules are preserved. A replacement intentionally replaces the entire selected rule.

Names and patterns are preserved by default. The optional default-branch mapping changes only exact source default
branch names, including exact `refs/heads/...` entries in ruleset includes/excludes. It never rewrites wildcard patterns;
`~DEFAULT_BRANCH` continues to mean the destination's default. Mapping collisions block the affected rules.
Overlapping classic patterns keep GitHub's precedence rules and should be reviewed before applying.

Required check names and app identities must have been observed on the target default branch's current commit.
A missing or inaccessible check history blocks the affected rule; the copier never drops checks or changes their
required app. Run the checks there before copying. Actor IDs are retained only when verified in target protection
allowances, target collaborators/teams, or existing target ruleset bypass actors. Teams are matched by identity, never
by a coincidentally identical slug in another organization. Unverified apps, roles, or actors block copying rather than
being substituted. Deployment requirements, inherited/non-branch rulesets, unknown rule types/parameters, undisclosed
bypass lists, and actor lists beyond the first 100 entries are shown but blocked for manual configuration on GitHub.
An incomplete source or target read blocks the whole operation rather than treating unread rules as absent.

The copier rechecks the preview before writing and each target identity immediately before changing it. GitHub does
not provide a transaction across rules. Writes run sequentially, stop on the first failure, and report applied, failed,
and skipped items. Successful writes are retained; no automatic retry or rollback occurs. A response lost in transit
may still represent an applied change, so the preview is consumed before writing. Settings and comparisons refresh
afterward, including partial failures; make a fresh selection to continue. All tokens remain in page memory.

### GitHub service status

The header status pill opens public GitHub service details: component statuses, active
incidents with update history, and scheduled or active maintenance. The page polls `GET /api/github/status` every
minute while signed in, using one request and timer. The relay reads GitHub's public
[summary API](https://www.githubstatus.com/api) with a ten-second timeout and shares a minute-long, on-demand
cache across pages. It sends no account credentials. Failed upstream reads also back off for a minute.

A failed refresh retains the last successful response and timestamp, visibly marked stale; without a successful
read, status is unavailable rather than operational. The popover links to GitHub Status, supports Escape, restores
focus on close, and dismisses when focus or a pointer leaves it. Standalone demo builds have no relay and show
unavailable status, never sample incidents as live service data.
