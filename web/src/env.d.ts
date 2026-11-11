/** Set when the demo is built for a pull request (see .github/workflows/preview.yml). */
interface ImportMetaEnv {
  readonly VITE_PULL_NUMBER?: string;
  readonly VITE_PULL_TITLE?: string;
  readonly VITE_PULL_URL?: string;
}
