import { ago, exact } from "./time.ts";

/** A relative time, with the exact one on hover. */
export function Ago({ at, now }: { at: string | number; now: number }) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return (
    <time dateTime={date.toISOString()} title={exact(at)}>
      {ago(at, now)}
    </time>
  );
}
