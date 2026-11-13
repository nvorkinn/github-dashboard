import { expect, test } from "vitest";
import { usablePatch } from "../components/PullReview.tsx";
import { pull } from "../components/testing.ts";
import { demoFiles } from "./files.ts";

test("every sample file has a patch the review shows in full", async () => {
  for (const number of [128, 131, 9]) {
    const { files, truncated } = await demoFiles(pull({ number }));
    expect(truncated).toBe(false);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(usablePatch(file), file.path).toBe(true);
  }
});
