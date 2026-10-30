import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { createApaxConfig } from "../src/domain/apax-config.js";
import { writeApax } from "../src/io/apax-writer.js";

describe("writeApax", () => {
  it("updates mappings and removes obsolete build inputs while preserving other content", () => {
    const originalContent = [
      "name: warehouse",
      "type: app",
      "targets:",
      '  - "1500"',
      "  - llvm",
      "catalogs:",
      '  "@ax/simatic-ax": ^2510.0.0',
      '  "@example/private": 3.2.1',
      "devDependencies:",
      '  "@ax/sdk": ^2510.0.0',
      "variables:",
      "  APAX_BUILD_ARGS:",
      "    - --debug",
      '  BIN_FOLDER: "./bin/1500"',
      '  IP_ADDRESS: "192.168.0.1"',
      "scripts:",
      "  load: apax sld load --input $BIN_FOLDER",
      "dependencies:",
      '  "@ax/system": ^10.2.7',
      '  "@example/unmapped": 1.2.3',
      "",
    ].join("\n");
    const config = createApaxConfig({}, "apax.yml", originalContent);
    config.migrated.catalogs = {
      "@ax-as/s7-catalog": "^2610.0.0",
      "@example/private": "3.2.1",
    };
    config.migrated.dependencies = {
      "@ax-as/system-lib": "^10.4.20",
      "@example/unmapped": "1.2.3",
    };
    config.migrated.devDependencies = { "@ax-as/sdk": "^2610.0.0" };

    const result = writeApax(config);
    const document = parse(result) as Record<string, unknown>;

    expect(document["dependencies"]).toEqual({
      "@ax-as/system-lib": "^10.4.20",
      "@example/unmapped": "1.2.3",
    });
    expect(document["devDependencies"]).toEqual({ "@ax-as/sdk": "^2610.0.0" });
    expect(document["catalogs"]).toEqual({
      "@ax-as/s7-catalog": "^2610.0.0",
      "@example/private": "3.2.1",
    });
    expect(document).not.toHaveProperty("targets");
    expect(document["variables"]).toEqual({
      BIN_FOLDER: "./bin/1500",
      IP_ADDRESS: "192.168.0.1",
    });
    expect(result).toContain("load: apax sld load --input $BIN_FOLDER");
    expect(result).toContain('IP_ADDRESS: "192.168.0.1"');
  });

  it("retains BIN_FOLDER when it is the only remaining variable", () => {
    const originalContent = [
      "name: warehouse",
      "type: app",
      "targets:",
      '  - "1500"',
      "catalogs:",
      '  "@ax/simatic-ax": ^2510.0.0',
      "dependencies: {}",
      "devDependencies: {}",
      "variables:",
      "  APAX_BUILD_ARGS:",
      "    - --debug",
      '  BIN_FOLDER: "./bin/1500"',
      "scripts:",
      "  build: apax build",
      "",
    ].join("\n");
    const config = createApaxConfig({}, "apax.yml", originalContent);
    config.migrated.catalogs = { "@ax-as/s7-catalog": "^2610.0.0" };

    const result = writeApax(config);
    const document = parse(result) as Record<string, unknown>;

    expect(document["variables"]).toEqual({ BIN_FOLDER: "./bin/1500" });
    expect(result).not.toContain("APAX_BUILD_ARGS");
    expect(result).toContain("scripts:");
    expect(result).toContain("build: apax build");
  });

  it("does not add dependency sections when none were read", () => {
    const originalContent = [
      "name: warehouse",
      "type: app",
      "targets: [llvm]",
      "catalogs:",
      '  "@ax/simatic-ax": ^2510.0.0',
      "",
    ].join("\n");
    const config = createApaxConfig({}, "apax.yml", originalContent);
    config.migrated.catalogs = { "@ax-as/s7-catalog": "^2610.0.0" };

    const result = writeApax(config);
    const document = parse(result) as Record<string, unknown>;

    expect(document).not.toHaveProperty("dependencies");
    expect(document).not.toHaveProperty("devDependencies");
  });

  it("does not add devDependencies when SDK is absent", () => {
    const originalContent = [
      "name: warehouse",
      "type: app",
      "targets: [llvm]",
      "catalogs:",
      '  "@ax/simatic-ax": ^2510.0.0',
      "dependencies:",
      '  "@example/runtime": 1.0.0',
      "",
    ].join("\n");
    const config = createApaxConfig({}, "apax.yml", originalContent);
    config.migrated.catalogs = { "@ax-as/s7-catalog": "^2610.0.0" };
    config.migrated.dependencies = { "@example/runtime": "1.0.0" };

    const result = writeApax(config);
    const document = parse(result) as Record<string, unknown>;

    expect(document["dependencies"]).toEqual({ "@example/runtime": "1.0.0" });
    expect(document).not.toHaveProperty("devDependencies");
  });

  it("writes one entry when an existing package and a renamed package converge", () => {
    const originalContent = [
      "devDependencies:",
      '  "@ax/cloudlink": ^1.0.0',
      '  "@ax/agent": ^1.1.1',
      "",
    ].join("\n");
    const config = createApaxConfig({}, "apax.yml", originalContent);
    config.migrated.devDependencies = { "@ax/cloudlink": "^1.1.1" };

    const result = writeApax(config);
    const document = parse(result) as Record<string, unknown>;

    expect(document["devDependencies"]).toEqual({ "@ax/cloudlink": "^1.1.1" });
    expect(result.match(/"@ax\/cloudlink"/gu)).toHaveLength(1);
    expect(result).not.toContain("@ax/agent");
  });

  it("updates APAX sections and package names case-insensitively", () => {
    const originalContent = [
      "TARGETS: [s7]",
      "CATALOGS:",
      '  "@AX/SIMATIC-AX": ^2510.0.0',
      "DEPENDENCIES:",
      '  "@AX/AX2TIA": ^12.0.0',
      "VARIABLES:",
      "  apax_build_args:",
      "    - --debug",
      "",
    ].join("\n");
    const config = createApaxConfig({}, "apax.yml", originalContent);
    config.migrated.catalogs = { "@ax-as/s7-catalog": "^2610.0.0" };
    config.migrated.dependencies = { "@ax-as/s7-1500-ax2tia": "^13.0.0" };

    const result = writeApax(config);
    const document = parse(result) as Record<string, unknown>;

    expect(document["DEPENDENCIES"]).toEqual({ "@ax-as/s7-1500-ax2tia": "^13.0.0" });
    expect(document["CATALOGS"]).toEqual({ "@ax-as/s7-catalog": "^2610.0.0" });
    expect(document).not.toHaveProperty("dependencies");
    expect(document).not.toHaveProperty("catalogs");
    expect(document).not.toHaveProperty("TARGETS");
    expect(document).not.toHaveProperty("VARIABLES");
  });
});