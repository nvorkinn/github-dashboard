import { expect, test } from "vitest";
import { fileIcon, folderIcon } from "./file_icons.ts";

const icon = (path: string) =>
  fileIcon(path)
    .split("/")
    .pop()
    ?.replace(/\.svg.*$/, "");

test("picks a file's icon by its whole name, then its longest known extension", () => {
  expect(icon("broker/routes/account.py")).toBe("python");
  expect(icon("web/src/App.tsx")).toBe("react_ts");
  expect(icon("web/src/App.test.tsx")).toBe("test-jsx");
  expect(icon("web/src/env.d.ts")).toBe("typescript-def");
  expect(icon("package.json")).toBe("nodejs");
  expect(icon("data.json")).toBe("json");
  expect(icon("Dockerfile")).toBe("docker");
  expect(icon("docs/README.md")).toBe("readme");
  expect(icon("NOTES.MD")).toBe("markdown");
  expect(icon("firmware/src/main.cpp")).toBe("cpp");
});

test("shows workflow files as workflows and anything unknown as a plain file", () => {
  expect(icon(".github/workflows/ci.yml")).toBe("github-actions-workflow");
  expect(icon("config/ci.yml")).toBe("yaml");
  expect(icon("bin/run")).toBe("file");
  expect(icon(".hidden")).toBe("file");
  expect(icon("archive.unknown")).toBe("file");
});

test("picks a folder's icon by its last name, open or closed", () => {
  const name = (url: string) =>
    url
      .split("/")
      .pop()
      ?.replace(/\.svg.*$/, "");
  expect(name(folderIcon("web/src", false))).toBe("folder-src");
  expect(name(folderIcon("web/src", true))).toBe("folder-src-open");
  expect(name(folderIcon("Tests", false))).toBe("folder-test");
  expect(name(folderIcon("broker", false))).toBe("folder");
  expect(name(folderIcon("broker", true))).toBe("folder-open");
});
