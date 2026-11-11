import { render } from "preact";
import { App, type DemoPull } from "./App.tsx";
import { createAuth } from "./auth.ts";
import { makeActions, makeDashboard } from "./dashboard_source.ts";
import "./style.css";

const auth = createAuth();

const demo = import.meta.env.MODE === "demo";
if (demo) {
  // Loaded only here, so the real build carries none of the sample data.
  const { installDemo } = await import("./demo.ts");
  installDemo({ onSignIn: () => void auth.start() });
}
const dashboard = await makeDashboard(auth, demo);
const actions = await makeActions(auth, dashboard, demo);

// A pull request's demo is built with the pull request in these (see .github/workflows/preview.yml).
const env = import.meta.env;
const pull: DemoPull | undefined =
  demo && env.VITE_PULL_NUMBER && env.VITE_PULL_URL
    ? { number: Number(env.VITE_PULL_NUMBER), title: env.VITE_PULL_TITLE ?? "", url: env.VITE_PULL_URL }
    : undefined;

const root = document.getElementById("app");
if (root) {
  render(<App auth={auth} dashboard={dashboard} actions={actions} demo={demo} pull={pull} />, root);
}
