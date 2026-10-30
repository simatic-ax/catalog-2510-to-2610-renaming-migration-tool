import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApaxConfig } from "../src/domain/apax-config.js";
import { CapturingLogger } from "../src/domain/logger.js";
import type { ApaxCommandRunner } from "../src/io/apax-command-runner.js";
import { acquireCatalog } from "../src/migration/catalog-resolver.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("acquireCatalog", () => {
  it("reads the version APAX linked in the temporary project's catalogs directory", async () => {
    const cacheRoot = temporaryDirectory();
    const selectedCatalog = writeCatalog(cacheRoot, "@ax-as/s7-catalog", "2610.0.0-test", {
      "@ax-as/system-lib": "11.0.0-test",
    });
    writeCatalog(cacheRoot, "@ax-as/s7-catalog", "2610.0.0-test", {
      "@ax-as/system-lib": "11.0.0-test",
    }, "duplicate-content-hash");
    writeCatalog(cacheRoot, "@ax-as/s7-catalog", "2610.0.0-other", {
      "@ax-as/system-lib": "99.0.0-test",
    });
    let workingDirectory = "";
    const runApax = vi.fn<ApaxCommandRunner>().mockImplementation(async (_arguments, cwd) => {
      workingDirectory = cwd;
      const path = join(cwd, "apax.yml");
      const document = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(document).toEqual({
        name: "catalogmigrate",
        version: "0.0.1",
        type: "app",
        registries: { "@ax-as": "https://registry.example.test/" },
        publicKeys: { "@ax-as": "" },
      });
      document.catalogs = { "@ax-as/s7-catalog": "2610.0.0-test" };
      writeFileSync(path, stringify(document), "utf8");
      const projectCatalogLink = join(
        cwd,
        ".apax",
        "catalogs",
        "@ax-as",
        "s7-catalog",
        "2610.0.0-test",
      );
      mkdirSync(dirname(projectCatalogLink), { recursive: true });
      symlinkSync(
        selectedCatalog,
        projectCatalogLink,
        process.platform === "win32" ? "junction" : "dir",
      );
      return { exitCode: 0, stderr: "", stdout: "" };
    });
    const source = createApaxConfig({
      registries: { "@ax-as": "https://registry.example.test/" },
      publicKeys: { "@ax-as": "" },
    }).original;

    const result = await acquireCatalog(
      source,
      { compatibility: "exact", name: "@ax-as/s7-catalog", version: "latest" },
      runApax,
      new CapturingLogger(),
    );

    expect(runApax).toHaveBeenCalledWith(
      ["add", "--catalog", "@ax-as/s7-catalog@latest", "--exact"],
      expect.any(String),
    );
    expect(result).toEqual({
      dependencies: { "@ax-as/system-lib": "11.0.0-test" },
      name: "@ax-as/s7-catalog",
      version: "2610.0.0-test",
    });
    expect(existsSync(workingDirectory)).toBe(false);
  });

  it("fails cleanly when APAX add fails", async () => {
    const logger = new CapturingLogger();
    let workingDirectory = "";
    const runApax: ApaxCommandRunner = async (_arguments, cwd) => {
      workingDirectory = cwd;
      return { exitCode: 1, stderr: "verbose failure", stdout: "" };
    };

    const result = await acquireCatalog(
      createApaxConfig().original,
      { compatibility: "caret", name: "@ax-as/s7-catalog", version: "latest" },
      runApax,
      logger,
    );

    expect(result).toBeUndefined();
    expect(logger.messages).toEqual([
      "Getting catalog @ax-as/s7-catalog@latest...",
      "Getting catalog failed: @ax-as/s7-catalog@latest. verbose failure",
    ]);
    expect(existsSync(workingDirectory)).toBe(false);
  });
});

function writeCatalog(
  cacheRoot: string,
  name: string,
  version: string,
  catalogDependencies: Record<string, string>,
  contentHash = "content-hash",
): string {
  const directory = join(cacheRoot, ...name.split("/"), version, contentHash);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "apax.yml"), stringify({
    name,
    version,
    type: "catalog",
    catalogDependencies,
  }), "utf8");
  return directory;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "catalog-resolver-test-"));
  temporaryDirectories.push(directory);
  return directory;
}