// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, expect, test } from "vitest";
import { rememberedLaneColumns, rememberedView, useLaneColumns, useView, ViewSwitch } from "./ViewSwitch.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function Switch() {
  const [view, setView] = useView();
  return (
    <>
      <ViewSwitch view={view} onChange={setView} />
      <p>{view}</p>
    </>
  );
}

const pressed = () =>
  screen
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((button) => button.textContent);

test("starts on Stage, switches on a press and remembers the choice", () => {
  render(<Switch />);
  expect(pressed()).toEqual(["Stage"]);
  fireEvent.click(screen.getByRole("button", { name: "Lanes" }));
  expect(pressed()).toEqual(["Lanes"]);
  expect(screen.getByText("lanes")).toBeTruthy();
  cleanup();

  render(<Switch />);
  expect(pressed()).toEqual(["Lanes"]);
});

test("falls back to Stage when what was remembered makes no sense", () => {
  localStorage.setItem("github-dashboard:view", "grid");
  expect(rememberedView()).toBe("stage");
});

test("remembers how many columns the lanes take, two unless one was chosen", () => {
  expect(rememberedLaneColumns()).toBe(2);
  function Probe() {
    const [columns, setColumns] = useLaneColumns();
    return (
      <button type="button" onClick={() => setColumns(columns === 2 ? 1 : 2)}>
        {columns}
      </button>
    );
  }
  render(<Probe />);
  fireEvent.click(screen.getByRole("button", { name: "2" }));
  expect(screen.getByRole("button").textContent).toBe("1");
  expect(rememberedLaneColumns()).toBe(1);
});
