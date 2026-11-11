import { render } from "preact";
import { App } from "./App.tsx";
import { createAuth } from "./auth.ts";
import { makeDashboard } from "./dashboard_source.ts";
import "./style.css";

const auth = createAuth();

const demo = import.meta.env.MODE === "demo";
if (demo) {
  // Loaded only here, so the real build carries none of the sample data.
  const { installDemo } = await import("./demo.ts");
  installDemo({ onSignIn: () => void auth.start() });
}
const dashboard = await makeDashboard(auth, demo);

const root = document.getElementById("app");
if (root) {
  render(<App auth={auth} dashboard={dashboard} demo={demo} />, root);
}
