# GitHub dashboard

See README.md for what this is, the layout and the commands.

- Before pushing, run `npm run check` and `npm test`.
- Dependencies are pinned to exact versions in package.json; Dependabot moves them.
- The relay is run by Node directly, so its TypeScript must be erasable (no enums, namespaces or parameter
  properties) and relative imports carry the `.ts` extension.
- The access token for api.github.com lives only in the page's memory. Never put it in localStorage, a cookie the
  page can read, or a log.
- The relay keeps no database and stores no tokens. Question any change that makes it remember something.
- Third-party GitHub Actions are pinned to commit SHAs with the version in a comment.
