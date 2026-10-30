import { describe, expect, it } from "vitest";
import { createApaxConfig } from "../src/domain/apax-config.js";
import { nullLogger } from "../src/domain/logger.js";
import { migrateApax } from "../src/migration/apax-migrator.js";

describe("migrateApax", () => {
  it("migrates without adding an SDK when no SDK dependency exists", () => {
    const config = createApaxConfig({
      projectType: "app",
      catalogs: { "@ax/simatic-ax": "^2510.0.0" },
      dependencies: { "@example/runtime": "1.0.0" },
    });

    expect(migrateApax(config, nullLogger)).toEqual({ mappedPackages: [] });
    expect(config.migrated.dependencies).toEqual({ "@example/runtime": "1.0.0" });
    expect(config.migrated.devDependencies).toEqual({});
  });

  it("removes the migration tool from both dependency sections", () => {
    const config = createApaxConfig({
      catalogs: { "@ax/simatic-ax": "^2510.0.0" },
      dependencies: {
        "@SIMATIC-AX/CATALOG-2510-TO-2610-RENAMING-MIGRATION-TOOL": "0.19.0",
      },
      devDependencies: {
        "@simatic-ax/catalog-2510-to-2610-renaming-migration-tool": "0.19.0",
      },
    });

    expect(migrateApax(config, nullLogger)).toEqual({ mappedPackages: [] });
    expect(config.migrated.dependencies).toEqual({});
    expect(config.migrated.devDependencies).toEqual({});
  });

  it("uses canonical mapped package names regardless of source casing", () => {
    const config = createApaxConfig({
      catalogs: { "@AX/SIMATIC-AX": "^2510.0.0" },
      dependencies: {
        "@AX/AX2TIA": "^12.0.0",
        "@Vendor/Unmapped-Pkg": "~3.2.12",
      },
    });

    expect(migrateApax(config, nullLogger)).toEqual({
      mappedPackages: ["@ax-as/s7-1500-ax2tia"],
    });
    expect(config.migrated.dependencies).toEqual({
      "@ax-as/s7-1500-ax2tia": "^12.0.0",
      "@Vendor/Unmapped-Pkg": "~3.2.12",
    });
  });

  it("migrates representative packages and preserves the original snapshot", () => {
    const config = createApaxConfig({
      catalogs: { "@ax/simatic-ax": "^2510.0.0", "@example/private": "3.2.1" },
      dependencies: {
        "@ax/system": "^10.2.7",
        "@ax/simatic-communication": "11.0.2",
        "@example/unmapped": "1.2.3",
      },
      devDependencies: { "@ax/sdk": "^2510.0.0", "@ax/axunitst-make": "^8.1.0" },
    });

    expect(migrateApax(config, nullLogger)).toEqual({
      mappedPackages: [
        "@ax-as/s7-sdk",
        "@ax-as/axunit-make",
        "@ax-as/system-lib",
        "@ax-as/s7-communication-lib",
      ],
    });
    expect(config.migrated.dependencies).toEqual({
      "@ax-as/system-lib": "^10.2.7",
      "@ax-as/s7-communication-lib": "11.0.2",
      "@example/unmapped": "1.2.3",
    });
    expect(config.migrated.devDependencies).toEqual({
      "@ax-as/s7-sdk": "^2510.0.0",
      "@ax-as/axunit-make": "^8.1.0",
    });
    expect(config.migrated.catalogs).toEqual({
      "@example/private": "3.2.1",
      "@ax-as/s7-catalog": "latest",
    });
    expect(config.original.catalogs["@ax/simatic-ax"]).toBe("^2510.0.0");
    expect(config.original.dependencies["@ax/system"]).toBe("^10.2.7");
  });

  it.each(["2510.2.3", "^2510.2.3", "~2510.2.3"])(
    "accepts source catalog version %s",
    (sourceVersion) => {
      const config = createApaxConfig({ catalogs: { "@ax/simatic-ax": sourceVersion } });

      expect(migrateApax(config, nullLogger, "@example/custom-catalog", "2610.2.0")).toEqual({
        mappedPackages: [],
      });
      expect(config.migrated.catalogs["@example/custom-catalog"]).toBe("2610.2.0");
    },
  );

  it.each(["^2410.0.0", "^2610.0.0", "12510.0.0", "^2510-preview", "^2510.0"])(
    "rejects unsupported catalog version %s without mutation",
    (catalog) => {
      const config = createApaxConfig({
        catalogs: { "@ax/simatic-ax": catalog },
        dependencies: { "@ax/system": "^10.2.7" },
      });

      expect(migrateApax(config, nullLogger)).toBeUndefined();
      expect(config.migrated.catalogs).toEqual({ "@ax/simatic-ax": catalog });
      expect(config.migrated.dependencies).toEqual({ "@ax/system": "^10.2.7" });
    },
  );
});