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

The relay reads four variables. With none set it runs without sign-in (the endpoints answer 503); with some
missing or wrong it refuses to start.

| Variable                   | Value                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_CLIENT_ID`     | The app's client ID (not its app ID).                                                                   |
| `GITHUB_APP_CLIENT_SECRET` | A client secret generated on the app's page.                                                            |
| `COOKIE_KEY`               | 32 random bytes in base64: `openssl rand -base64 32`. Changing it signs everyone out.                   |
| `PUBLIC_URL`               | Where the browser reaches the relay, `https://github.vorkinn.org`. Cookies are Secure when it is https. |

The GitHub App (Settings, Developer settings, GitHub Apps):

- Callback URL: `https://github.vorkinn.org/api/auth/callback`, plus `http://localhost:5173/api/auth/callback` to
  sign in while developing.
- "Expire user authorization tokens": on. Without it GitHub gives no refresh token and the sign-in fails.
- "Request user authorization (OAuth) during installation": as you like; the page starts the sign-in itself.
- No webhook is needed for signing in.

To sign in locally, start the relay with the four variables and `PUBLIC_URL=http://localhost:5173`, and open the
page from `npm run dev`: Vite passes `/api` on to the relay, so the browser sees one origin. Without Vite, use
`PUBLIC_URL=http://localhost:8080` (and that callback URL in the app) with `npm run build && npm start`.

## Previews

The demo is the page running on built-in sample data (`web/src/demo.ts`), with no relay, sign-in or GitHub behind it:
it starts signed in as a sample user.
The Preview workflow publishes it to GitHub Pages from the `gh-pages` branch:

- each pull request's at `https://nvorkinn.github.io/github-dashboard/pr-<number>/`, linked from the pull request as
  a deployment ("View deployment"), and removed when the pull request closes;
- main's at `https://nvorkinn.github.io/github-dashboard/`.

When the page learns something new to show, give the demo sample data for it, so the preview shows it too. Pull
requests from forks and from Dependabot get no preview.

## Pull requests

`main` takes changes only through pull requests, and requires one check, "Global PR Status". The All checks workflow
completes it once every other workflow on the commit has passed; a new workflow that runs on pull requests has to be
added to its list (`tests/workflows.test.ts` fails until it is).
