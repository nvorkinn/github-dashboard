# GitHub dashboard

See README.md for what this is, the layout and the commands.

- Before pushing, run `npm run check` and `npm test`.
- Dependencies are pinned to exact versions in package.json; Dependabot moves them.
- The relay is run by Node directly, so its TypeScript must be erasable (no enums, namespaces or parameter
  properties) and relative imports carry the `.ts` extension.
- The access token for api.github.com lives only in the page's memory. Never put it in localStorage, a cookie the
  page can read, or a log.
- The relay keeps no database and stores no user's token. What it knows of release workflows and their runs it reads
  as the GitHub App and holds in memory only, with an installation token that lasts an hour. Question any change
  that makes it remember something more, or write to GitHub.
- The relay logs why a sign-in, refresh or read of GitHub failed, never a token, code, cookie, key or secret.
- Third-party GitHub Actions are pinned to commit SHAs with the version in a comment.
