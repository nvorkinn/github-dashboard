import { render } from "preact";
import { App } from "./App.tsx";

const demo = import.meta.env.MODE === "demo";
if (demo) {
  // Loaded only here, so the real build carries none of the sample data.
  const { installDemo } = await import("./demo.ts");
  installDemo();
}

const root = document.getElementById("app");
if (root) {
  render(<App demo={demo} />, root);
}
