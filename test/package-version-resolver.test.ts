import { describe, expect, it, vi } from "vitest";
import { createApaxConfig } from "../src/domain/apax-config.js";
import { CapturingLogger } from "../src/domain/logger.js";
import type { ApaxCommandRunner } from "../src/io/apax-command-runner.js";
import {
  applyCatalogVersions,
  resolvePackageVersions,
} from "../src/migration/package-version-resolver.js";

describe("applyCatalogVersions", () => {
  it("updates present catalog packages and returns packages absent from the catalog", () => {
    const config = createApaxConfig({
      dependencies: {
        "@ax-as/system-lib": "^10.0.0",
        "@ax-as/axunit-make": "old-make",
      },
      devDependencies: { "@AX-AS/S7-CLOCKS-LIB": "~11.0.0" },
    });

    const nonCatalogPackages = applyCatalogVersions(
      config,
      ["@ax-as/system-lib", "@ax-as/s7-clocks-lib", "@ax-as/axunit-make"],
      {
        "@AX-AS/SYSTEM-LIB": "11.0.0-test",
        "@ax-as/s7-clocks-lib": "12.0.0-test",
        "@ax-as/not-installed": "1.0.0",
      },
    );

    expect(config.migrated.dependencies).toEqual({
      "@ax-as/system-lib": "^11.0.0-test",
      "@ax-as/axunit-make": "old-make",
    });
    expect(config.migrated.devDependencies["@AX-AS/S7-CLOCKS-LIB"])
      .toBe("~12.0.0-test");
    expect(nonCatalogPackages).toEqual(["@ax-as/axunit-make"]);
  });
});

describe("resolvePackageVersions", () => {
  it("uses apax list output for dependencies and dev dependencies", async () => {
    const config = createApaxConfig({
      dependencies: { "@ax-as/axunit-make": "^8.1.0" },
      devDependencies: { "@ax-as/axunit-make": "~8.1.0" },
    });
    const runApax = vi.fn<ApaxCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: "9.6.6\n",
    });

    const logger = new CapturingLogger();
    await resolvePackageVersions(
      config,
      ["@ax-as/axunit-make"],
      "C:/project",
      runApax,
      logger,
    );

    expect(runApax).toHaveBeenCalledWith(
      ["list", "-p", "@ax-as/axunit-make"],
      "C:/project",
    );
    expect(config.migrated.dependencies["@ax-as/axunit-make"]).toBe("^9.6.6");
    expect(config.migrated.devDependencies["@ax-as/axunit-make"]).toBe("~9.6.6");
    expect(logger.messages).toContain("Getting the version of @ax-as/axunit-make");
  });

  it("uses the latest tag from APAX 4.4 package output", async () => {
    const config = createApaxConfig({
      dependencies: { "@ax-as/s7-clocks-lib": "11.0.116" },
    });
    const runApax = vi.fn<ApaxCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: [
        "Package name",
        "  @ax-as/s7-clocks-lib",
        "",
        "Versions",
        "- 12.0.64-x8a64328488",
        "- 12.0.66-x43b6bbfc17",
        "",
        "Tags",
        "  - latest: 12.0.66-x43b6bbfc17",
      ].join("\n"),
    });

    const success = await resolvePackageVersions(
      config,
      ["@ax-as/s7-clocks-lib"],
      "C:/project",
      runApax,
      new CapturingLogger(),
    );

    expect(success).toBe(true);
    expect(config.migrated.dependencies["@ax-as/s7-clocks-lib"])
      .toBe("12.0.66-x43b6bbfc17");
  });

  it.each([
    { result: { exitCode: 1, stderr: "not found", stdout: "" }, name: "command failure" },
    { result: { exitCode: 0, stderr: "", stdout: "unexpected output" }, name: "invalid output" },
  ])("uses latest and continues after $name", async ({ result }) => {
    const config = createApaxConfig({
      dependencies: {
        "@ax-as/axunit-make": "^8.1.0",
        "@ax/cloudlink": "~1.0.0",
      },
    });
    const logger = new CapturingLogger();
    const runApax = vi.fn<ApaxCommandRunner>()
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "1.2.0" });

    const success = await resolvePackageVersions(
      config,
      ["@ax-as/axunit-make", "@ax/cloudlink"],
      "C:/project",
      runApax,
      logger,
    );

    expect(success).toBe(true);
    expect(config.migrated.dependencies["@ax-as/axunit-make"]).toBe("latest");
    expect(config.migrated.dependencies["@ax/cloudlink"]).toBe("~1.2.0");
    expect(logger.messages).toEqual([
      "Getting the version of @ax-as/axunit-make",
      "APAX list failed: @ax-as/axunit-make",
      "Getting the version of @ax/cloudlink",
    ]);
  });

  it("uses latest when apax cannot start", async () => {
    const config = createApaxConfig({
      dependencies: { "@ax-as/axunit-make": "8.1.0" },
    });
    const logger = new CapturingLogger();
    const runApax = vi.fn<ApaxCommandRunner>().mockRejectedValue(new Error("spawn failed"));

    const success = await resolvePackageVersions(
      config,
      ["@ax-as/axunit-make"],
      "C:/project",
      runApax,
      logger,
    );

    expect(success).toBe(true);
    expect(config.migrated.dependencies["@ax-as/axunit-make"]).toBe("latest");
    expect(logger.messages).toEqual([
      "Getting the version of @ax-as/axunit-make",
      "APAX list failed: @ax-as/axunit-make",
    ]);
  });
});
