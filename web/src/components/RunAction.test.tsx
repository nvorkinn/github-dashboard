// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CONFIRM_MS, DONE_MS, RunAction } from "./RunAction.tsx";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A promise the test settles by hand. */
function later<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Lets the promises settle and Preact draw what came of them. */
async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

test("runs at once without a question, disabled and saying so while under way, then says what it did", async () => {
  const done = later<string>();
  const run = vi.fn(() => done.promise);
  render(<RunAction label="Re-run failed jobs" busy="Starting…" run={run} />);
  fireEvent.click(screen.getByRole("button", { name: "Re-run failed jobs" }));
  expect(run).toHaveBeenCalledOnce();
  const busy = screen.getByRole("button", { name: "Starting…" }) as HTMLButtonElement;
  expect(busy.disabled).toBe(true);
  expect(busy.getAttribute("aria-busy")).toBe("true");

  done.resolve("Re-run started.");
  await flush();
  expect(screen.getByRole("status").textContent).toBe("Re-run started.");
  expect(screen.queryByRole("button")).toBeNull();

  // By then the data shows it; the button is back for another go.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DONE_MS);
  });
  expect(screen.getByRole("button", { name: "Re-run failed jobs" })).toBeTruthy();
});

test("says why it failed next to the button, which can be tried again", async () => {
  const run = vi.fn(async () => {
    throw new Error("GitHub refused (403).");
  });
  render(<RunAction label="Re-run" name="Re-run build" busy="Starting…" run={run} />);
  fireEvent.click(screen.getByRole("button", { name: "Re-run build" }));
  await flush();
  expect(screen.getByRole("alert").textContent).toBe("GitHub refused (403).");
  fireEvent.click(screen.getByRole("button", { name: "Re-run build" }));
  expect(run).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("asks first, in place, and acts only on Confirm", async () => {
  const run = vi.fn(async () => "Approved production.");
  render(<RunAction label="Approve production" busy="Approving…" ask={() => "Approve production?"} run={run} />);
  fireEvent.click(screen.getByRole("button", { name: "Approve production" }));
  expect(run).not.toHaveBeenCalled();
  expect(screen.getByText("Approve production?")).toBeTruthy();
  const confirm = screen.getByRole("button", { name: "Confirm" });
  // The focus goes with the question, so the keyboard can answer it.
  expect(document.activeElement).toBe(confirm);

  fireEvent.click(confirm);
  expect(run).toHaveBeenCalledOnce();
  await flush();
  expect(screen.getByRole("status").textContent).toBe("Approved production.");
});

test("Cancel takes the question back, and so does waiting", async () => {
  const run = vi.fn(async () => "done");
  render(<RunAction label="Reject" busy="Rejecting…" secondary ask={() => "Reject production?"} run={run} />);
  fireEvent.click(screen.getByRole("button", { name: "Reject" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText("Reject production?")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Reject" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CONFIRM_MS - 1);
  });
  expect(screen.getByText("Reject production?")).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.queryByText("Reject production?")).toBeNull();
  expect((screen.getByRole("button", { name: "Reject" }) as HTMLElement).className).toBe("action secondary");
  expect(run).not.toHaveBeenCalled();
});

test("works out what it is about before asking, and says so meanwhile", async () => {
  const tag = later<string>();
  const run = vi.fn(async (prepared: string) => `Released ${prepared}.`);
  render(
    <RunAction<string>
      label="Release"
      busy="Releasing…"
      prepare={() => tag.promise}
      ask={(prepared) => `Release ${prepared}?`}
      run={run}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Release" }));
  expect((screen.getByRole("button", { name: "Checking…" }) as HTMLButtonElement).disabled).toBe(true);
  tag.resolve("v1.3.0");
  await flush();
  expect(screen.getByText("Release v1.3.0?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(screen.getByRole("button", { name: "Releasing…" })).toBeTruthy();
  expect(run).toHaveBeenCalledWith("v1.3.0");
  await flush();
  expect(screen.getByRole("status").textContent).toBe("Released v1.3.0.");
});

test("a failure to work it out is said without asking anything", async () => {
  const run = vi.fn(async () => "");
  render(
    <RunAction<string>
      label="Release"
      busy="Releasing…"
      prepare={async () => {
        throw new Error("Tag v3.1.0 already exists. Resolve it on GitHub before releasing.");
      }}
      ask={(prepared) => `Release ${prepared}?`}
      run={run}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Release" }));
  await flush();
  expect(screen.getByRole("alert").textContent).toBe(
    "Tag v3.1.0 already exists. Resolve it on GitHub before releasing.",
  );
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  expect(run).not.toHaveBeenCalled();
});

test("says what came of it where onNotice puts it, instead of next to the button", async () => {
  const onNotice = vi.fn();
  const run = vi.fn(async () => {
    throw new Error("No.");
  });
  render(<RunAction label="Re-run" busy="Starting…" onNotice={onNotice} run={run} />);
  fireEvent.click(screen.getByRole("button", { name: "Re-run" }));
  expect(onNotice).toHaveBeenLastCalledWith(undefined);
  await flush();
  expect(onNotice).toHaveBeenLastCalledWith({ text: "No.", failed: true });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("an action that ends after its button went away changes nothing", async () => {
  const done = later<string>();
  const { unmount } = render(<RunAction label="Re-run" busy="Starting…" run={() => done.promise} />);
  fireEvent.click(screen.getByRole("button", { name: "Re-run" }));
  unmount();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  done.resolve("Re-run started.");
  await flush();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DONE_MS);
  });
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});
