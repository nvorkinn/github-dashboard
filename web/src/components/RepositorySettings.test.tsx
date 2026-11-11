// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { CopyPreview, CopyResult, Repository, RepositoryConfig } from "../github/repository_config.ts";
import { ActionsContext } from "./actions.tsx";
import { RepositorySettings } from "./RepositorySettings.tsx";
import { NOW, project } from "./testing.ts";
import { Workspace } from "./Workspace.tsx";

const target = "octo/target";
const source = "octo/source";
const repo = (full_name = target, more = {}): Repository => ({
  full_name,
  node_id: `repo:${full_name}`,
  default_branch: "main",
  permissions: { admin: true },
  delete_branch_on_merge: true,
  allow_auto_merge: false,
  allow_merge_commit: true,
  allow_squash_merge: true,
  allow_rebase_merge: false,
  ...more,
});
const plan = (): CopyPreview => ({
  source,
  target,
  mapDefault: false,
  fingerprint: "test",
  problems: [],
  changes: [
    {
      key: "one",
      label: "Classic protection: main",
      kind: "classic",
      action: "Add",
      before: undefined,
      after: { pattern: "main" },
      problems: [],
      notes: [],
    },
    {
      key: "two",
      label: "Ruleset: Review",
      kind: "ruleset",
      action: "Replace",
      before: { name: "Review", enforcement: "disabled" },
      after: { name: "Review", enforcement: "active" },
      problems: [],
      notes: [],
    },
    {
      key: "three",
      label: "Target protection: production",
      kind: "classic",
      action: "Unchanged",
      before: {},
      after: {},
      problems: [],
      notes: [],
    },
  ],
});
function service() {
  return {
    read: vi.fn(async () => repo()),
    repositories: vi.fn(async () => [repo(), repo(source)]),
    save: vi.fn(async () => {}),
    preview: vi.fn(async () => plan()),
    apply: vi.fn(
      async (): Promise<CopyResult[]> => [
        { label: "Classic protection: main", status: "applied" as const, message: "Applied on GitHub." },
      ],
    ),
  } satisfies RepositoryConfig;
}
afterEach(cleanup);
async function openPreview(config = service()) {
  render(<RepositorySettings repo={target} service={config} />);
  await screen.findByRole("option", { name: source });
  fireEvent.change(screen.getByRole("combobox", { name: "Source repository" }), { target: { value: source } });
  fireEvent.click(screen.getByRole("button", { name: "Preview rules" }));
  await screen.findByText("Classic protection: main");
  return config;
}

test("shows current toggle values, excludes target from sources and saves then refreshes", async () => {
  const config = service();
  render(<RepositorySettings repo={target} service={config} />);
  const toggle = await screen.findByRole("switch", { name: "Delete branches after merging" });
  expect((toggle as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByRole("option", { name: target })).toBeNull();
  fireEvent.click(toggle);
  await waitFor(() => expect(config.save).toHaveBeenCalledWith(target, "delete_branch_on_merge", false, true));
  await waitFor(() => expect(config.read).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("status")).toBeTruthy();
});

test("selection and a second explicit confirmation are required before copying", async () => {
  const config = await openPreview();
  const button = screen.getByRole("button", { name: "Apply 0 selected changes" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /Add Classic protection/ }));
  fireEvent.click(screen.getByRole("button", { name: "Apply 1 selected changes" }));
  expect(config.apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: `Confirm copy to ${target}` }));
  await waitFor(() => expect(config.apply).toHaveBeenCalledWith(expect.objectContaining({ source, target }), ["one"]));
  expect(await screen.findByRole("list", { name: "Copy results" })).toBeTruthy();
  await waitFor(() => expect(config.preview).toHaveBeenCalledTimes(2));
  expect((screen.getByRole("checkbox", { name: /Unchanged Target protection/ }) as HTMLInputElement).disabled).toBe(
    true,
  );
});

test("changing branch mapping discards the old preview and confirmation", async () => {
  const config = await openPreview();
  fireEvent.click(screen.getByRole("checkbox", { name: /Replace Ruleset/ }));
  fireEvent.click(screen.getByRole("button", { name: "Apply 1 selected changes" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Map the source default/ }));
  expect(screen.queryByRole("button", { name: `Confirm copy to ${target}` })).toBeNull();
  expect(screen.queryByText("Classic protection: main")).toBeNull();
  expect(config.apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Preview rules" }));
  await waitFor(() => expect(config.preview).toHaveBeenLastCalledWith(source, target, true));
});

test("read-only users can preview but cannot select or save", async () => {
  const config = service();
  config.read.mockResolvedValue(repo(target, { permissions: { admin: false } }));
  await openPreview(config);
  expect(screen.getByText(/Read only/)).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: /Add Classic/ }) as HTMLInputElement).disabled).toBe(true);
  const toggle = screen.getByRole("switch", { name: "Allow auto-merge" }) as HTMLInputElement;
  expect(toggle.closest("fieldset")?.disabled).toBe(true);
});

test("blocked and partial previews explain their problems and disable changes", async () => {
  const config = service();
  const value = plan();
  value.problems = ["Source classic protections could not be read."];
  const change = value.changes[0];
  if (change) change.problems = ["Required CI check is not verified."];
  config.preview.mockResolvedValue(value);
  await openPreview(config);
  expect(screen.getByRole("alert").textContent).toContain("could not be read");
  expect(screen.getByText("Required CI check is not verified.")).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: /Replace Ruleset/ }) as HTMLInputElement).disabled).toBe(true);
});

test("failed copies show per-rule outcomes and refresh both settings and the comparison", async () => {
  const config = service();
  config.apply.mockResolvedValue([
    { label: "Classic protection: main", status: "failed", message: "GitHub refused (403)." },
  ]);
  await openPreview(config);
  fireEvent.click(screen.getByRole("checkbox", { name: /Add Classic/ }));
  fireEvent.click(screen.getByRole("button", { name: "Apply 1 selected changes" }));
  fireEvent.click(screen.getByRole("button", { name: `Confirm copy to ${target}` }));
  const results = await screen.findByRole("list", { name: "Copy results" });
  expect(within(results).getByText(/GitHub refused/)).toBeTruthy();
  await waitFor(() => expect(config.preview).toHaveBeenCalledTimes(2));
  expect(config.read).toHaveBeenCalledTimes(2);
});

test("save refusals retain server values and expose the error", async () => {
  const config = service();
  config.save.mockRejectedValue(new Error("Administration permission is required."));
  render(<RepositorySettings repo={target} service={config} />);
  fireEvent.click(await screen.findByRole("switch", { name: "Allow auto-merge" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Administration permission");
  expect((screen.getByRole("switch", { name: "Allow auto-merge" }) as HTMLInputElement).checked).toBe(false);
});

test("workspace integrates settings only for the selected repository, separately from pull review", async () => {
  const config = service();
  render(
    <ActionsContext.Provider value={{ repositories: config }}>
      <Workspace
        projects={[project({ repo: target, name: "target" }), project({ repo: source, name: "source" })]}
        pulls={[]}
        runs={[]}
        now={NOW}
        hidden={new Set()}
        onToggle={() => {}}
      />
    </ActionsContext.Provider>,
  );
  expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Repositories" })).getByRole("button", { name: "target" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Repository settings" });
  const sections = screen.getByRole("navigation", { name: "Workspace sections" });
  expect(within(sections).getByRole("button", { name: "Settings" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("region", { name: "Dashboard summary" })).toBeNull();
  fireEvent.click(within(sections).getByRole("button", { name: "Pull requests" }));
  expect(screen.queryByRole("heading", { name: "Repository settings" })).toBeNull();
  fireEvent.click(within(sections).getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Repository settings" });
  expect(config.read).toHaveBeenCalledWith(target);
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Repositories" })).getByRole("button", { name: "source" }),
  );
  expect(screen.queryByRole("heading", { name: "Repository settings" })).toBeNull();
});

test("leaving the Settings tab discards a pending copy confirmation", async () => {
  const config = service();
  render(
    <ActionsContext.Provider value={{ repositories: config }}>
      <Workspace
        projects={[project({ repo: target, name: "target" })]}
        pulls={[]}
        runs={[]}
        now={NOW}
        hidden={new Set()}
        onToggle={() => {}}
      />
    </ActionsContext.Provider>,
  );
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Repositories" })).getByRole("button", { name: "target" }),
  );
  const sections = screen.getByRole("navigation", { name: "Workspace sections" });
  fireEvent.click(within(sections).getByRole("button", { name: "Settings" }));
  await screen.findByRole("option", { name: source });
  fireEvent.change(screen.getByRole("combobox", { name: "Source repository" }), { target: { value: source } });
  fireEvent.click(screen.getByRole("button", { name: "Preview rules" }));
  await screen.findByText("Classic protection: main");
  fireEvent.click(screen.getByRole("checkbox", { name: /Add Classic protection/ }));
  fireEvent.click(screen.getByRole("button", { name: "Apply 1 selected changes" }));
  expect(screen.getByRole("button", { name: `Confirm copy to ${target}` })).toBeTruthy();
  fireEvent.click(within(sections).getByRole("button", { name: "Overview" }));
  fireEvent.click(within(sections).getByRole("button", { name: "Settings" }));
  await screen.findByRole("combobox", { name: "Source repository" });
  expect(screen.queryByRole("button", { name: `Confirm copy to ${target}` })).toBeNull();
  expect(config.apply).not.toHaveBeenCalled();
});
