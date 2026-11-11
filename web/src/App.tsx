import { useEffect, useState } from "preact/hooks";

type Health = "checking" | "ok" | "down";

/** The page so far: shows whether the relay answers. Sign-in and the dashboard itself come next. */
export function App({ demo = false }: { demo?: boolean }) {
  const [health, setHealth] = useState<Health>("checking");

  useEffect(() => {
    fetch("healthz")
      .then((response) => setHealth(response.ok ? "ok" : "down"))
      .catch(() => setHealth("down"));
  }, []);

  return (
    <main>
      {demo && <p role="note">Demo: sample data, nothing here is real.</p>}
      <h1>GitHub dashboard</h1>
      <p>Relay: {health === "checking" ? "checking…" : health === "ok" ? "up" : "not reachable"}</p>
    </main>
  );
}
