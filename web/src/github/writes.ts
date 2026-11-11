import type { Auth } from "../auth.ts";
import { GitHubError, retryAt } from "./api.ts";
import { describe } from "./dashboard.ts";

/** An action that didn't go through. Its message is for the user as it is. */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

/**
 * A write whose outcome isn't known: GitHub couldn't be reached, or had trouble, after it was sent. It may have gone
 * through, so it is never simply tried again.
 */
class Uncertain extends Error {
  reason: unknown;

  constructor(reason: unknown) {
    super("The write's outcome is unknown");
    this.name = "Uncertain";
    this.reason = reason;
  }
}

/**
 * Sends one write to api.github.com and gives GitHub's answer. Never tried again on its own: it may have gone
 * through. A refusal is an `ActionError` in GitHub's own words where it gives some; `needs` names the permissions
 * the app needs for it, for when GitHub says the app isn't allowed.
 */
export async function send(auth: Auth, path: string, method: string, body: unknown, needs: string): Promise<Response> {
  let response: Response;
  try {
    response = await auth.github(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Uncertain(error);
  }
  if (!response.ok) {
    const retry = await retryAt(response.clone());
    if (retry === undefined && response.status >= 500) {
      throw new Uncertain(new GitHubError(path, response.status, undefined));
    }
    throw new ActionError(await refusal(path, response, retry, needs));
  }
  return response;
}

/** Why GitHub didn't take a write, in words for the user: its own message where it gives one. */
async function refusal(path: string, response: Response, retry: number | undefined, needs: string): Promise<string> {
  if (retry !== undefined || response.status === 401) {
    return describe(new GitHubError(path, response.status, retry));
  }
  const body = (await response.json().catch(() => undefined)) as { message?: unknown } | undefined;
  const message = typeof body?.message === "string" ? body.message : "";
  if (response.status === 403 && /not accessible by integration/i.test(message)) {
    return `The GitHub App isn't allowed to do this. It needs ${needs} with write access.`;
  }
  return message ? refusedWith(message) : `GitHub refused (${response.status}).`;
}

/** GitHub's own reason, as a sentence. */
export function refusedWith(message: string): string {
  const said = message.trim().replace(/\.$/, "");
  return said ? `GitHub refused: ${said}.` : "GitHub refused.";
}

/** Runs an action, making whatever it throws an `ActionError` with words for the user. */
export async function worded<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw error instanceof ActionError ? error : new ActionError(describeAction(error));
  }
}

/** Why an action didn't go through, in words for the user. */
export function describeAction(error: unknown): string {
  if (error instanceof ActionError) {
    return error.message;
  }
  if (error instanceof Uncertain) {
    return `${describe(error.reason)} It may have gone through: check GitHub before trying again.`;
  }
  // A read before the write, such as a check that the action still applies.
  if (error instanceof GitHubError && error.retryAt === undefined && error.status !== 401 && error.status < 500) {
    return `GitHub refused (${error.status}).`;
  }
  return describe(error);
}
