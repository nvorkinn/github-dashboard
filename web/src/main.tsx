import { render } from "preact";
import { App } from "./App.tsx";
import { createAuth } from "./auth.ts";
import "./style.css";

const auth = createAuth();

const demo = import.meta.env.MODE === "demo";
if (demo) {
  // Loaded only here, so the real build carries none of the sample data.
  const { installDemo } = await import("./demo.ts");
  installDemo({ onSignIn: () => void auth.start() });
}

const root = document.getElementById("app");
if (root) {
  render(<App auth={auth} demo={demo} />, root);
}
