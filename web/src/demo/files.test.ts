// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { isBinary } from "../components/ImageDiff.tsx";
import { usablePatch } from "../components/PullReview.tsx";
import { pull } from "../components/testing.ts";
import { hasSide, imageType } from "../github/images.ts";
import { demoFiles, demoImage } from "./files.ts";

test("every sample text file has a patch the review shows in full", async () => {
  for (const number of [128, 131, 9]) {
    const { files, truncated } = await demoFiles(pull({ number }));
    expect(truncated).toBe(false);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) if (!isBinary(file)) expect(usablePatch(file), file.path).toBe(true);
  }
});

test("every sample image has a picture for each side it has", async () => {
  const { files } = await demoFiles(pull({ number: 128 }));
  const images = files.filter((file) => imageType(file.path));
  expect(images.length).toBeGreaterThan(0);
  for (const file of images)
    for (const side of ["before", "after"] as const)
      if (hasSide(file, side)) expect((await demoImage(pull(), file, side)).url).toMatch(/^data:image\//);
});
