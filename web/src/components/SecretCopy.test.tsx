// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { Repository } from "../github/repository_config.ts";
import type { SecretCopy, SecretCopyOutcome } from "../github/secret_copy.ts";
import { SecretCopyCard } from "./SecretCopy.tsx";

const target = "octo/target";
const source = "octo/source";
const repositories = [{ full_name: source, node_id: "r", default_branch: "main" }] satisfies Repository[];
function service() {
  return {
    names: vi.fn(async (repo: string) => (repo === source ? ["TOKEN", "OTHER"] : ["OTHER"])),
    copy: vi.fn(
      async (): Promise<SecretCopyOutcome> => ({
        results: [{ name: "TOKEN", status: "copied", message: "Stored on GitHub." }],
        leftover: undefined,
      }),
    ),
  } satisfies SecretCopy;
}
afterEach(cleanup);
async function choose(config = service(), canEdit = true) {
  render(<SecretCopyCard repo={target} repositories={repositories} canEdit={canEdit} service={config} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Copy secrets from" }), { target: { value: source } });
  await screen.findByRole("checkbox", { name: /TOKEN/ });
  return config;
}

test("lists the source's secrets, marks the ones it would replace and copies only after confirming", async () => {
  const config = await choose();
  expect(screen.getByRole("checkbox", { name: "Add TOKEN" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Replace OTHER" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Copy 0 selected secrets" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Add TOKEN" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy 1 selected secrets" }));
  expect(config.copy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: `Confirm copy to ${target}` }));
  await waitFor(() => expect(config.copy).toHaveBeenCalledWith(source, target, ["TOKEN"], expect.any(Function)));
  expect(await screen.findByRole("list", { name: "Secret copy results" })).toBeTruthy();
  expect(await screen.findByRole("checkbox", { name: "Replace TOKEN" })).toBeTruthy();
});

test("shows why a copy failed and what was left behind", async () => {
  const config = service();
  config.copy.mockResolvedValueOnce({ results: [], leftover: "Couldn't remove the branch." });
  await choose(config);
  fireEvent.click(screen.getByRole("checkbox", { name: "Add TOKEN" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy 1 selected secrets" }));
  fireEvent.click(screen.getByRole("button", { name: `Confirm copy to ${target}` }));
  expect((await screen.findByRole("alert")).textContent).toBe("Couldn't remove the branch.");
  config.copy.mockRejectedValueOnce(new Error("No workflow started."));
  fireEvent.click(screen.getByRole("checkbox", { name: "Add TOKEN" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy 1 selected secrets" }));
  fireEvent.click(screen.getByRole("button", { name: `Confirm copy to ${target}` }));
  expect(await screen.findByText("No workflow started.")).toBeTruthy();
});

test("someone who can't change the repository can look but not copy", async () => {
  await choose(service(), false);
  expect(screen.getByText(/Read only/)).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "Add TOKEN" }) as HTMLInputElement).disabled).toBe(true);
});
