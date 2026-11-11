// Reading a webhook's payload defensively: each helper takes whatever is there and gives back a value of the
// expected type, or nothing, so a payload of an unexpected shape reads as missing values instead of throwing.

const SHA = /^[0-9a-f]{40,64}$/;
const MAX_TEXT = 200;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value if it is a JSON object, and an empty one otherwise, so a missing branch reads as missing leaves. */
export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** A string short enough to be a name, such as an action or a repository's full name. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT ? value : undefined;
}

export function commit(value: unknown): string | undefined {
  return typeof value === "string" && SHA.test(value) ? value : undefined;
}

export function wholeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** The numbers of the pull requests in a check's or run's `pull_requests`, leaving out entries that have none. */
export function pullNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const numbers: number[] = [];
  for (const entry of value) {
    const number = wholeNumber(record(entry).number);
    if (number !== undefined) {
      numbers.push(number);
    }
  }
  return numbers;
}
