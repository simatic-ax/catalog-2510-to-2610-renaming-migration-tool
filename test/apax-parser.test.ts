import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Logger } from "../src/domain/logger.js";
import { tryParseApax } from "../src/io/apax-parser.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("tryParseApax", () => {
  it("returns undefined for a missing file", () => {
    const logger = createCapturingLogger();

    expect(tryParseApax(join(tmpdir(), "missing-apax.yml"), logger)).toBeUndefined();
    expect(logger.errors[0]).toContain("Could not find apax.yml");
  });

  it("returns undefined for missing content", () => {
    const logger = createCapturingLogger();
    const filePath = writeApax("  \n");

    expect(tryParseApax(filePath, logger)).toBeUndefined();
    expect(logger.errors).toEqual([`Could not find content in ${filePath}`]);
  });

  it("returns undefined when type is missing", () => {
    const logger = createCapturingLogger();
    const filePath = writeApax("name: workspace\n");

    expect(tryParseApax(filePath, logger)).toBeUndefined();
    expect(logger.errors[0]).toContain("Failed to read project type");
  });

  it("parses a minimal workspace without project configuration", () => {
    const filePath = writeApax("type: workspace\n");

    const config = tryParseApax(filePath, createCapturingLogger());

    expect(config?.original.projectType).toBe("workspace");
    expect(config?.original.targets).toEqual([]);
  });

  it("parses valid app values and creates an independent migrated copy", () => {
    const content = `name: warehouse
version: 0.0.1
type: app
targets:
  - "1500"
  - llvm
catalogs:
  "@ax/simatic-ax": ^2510.0.0
  "@example/private": 3.2.1
devDependencies:
  "@ax/sdk": ^2510.0.0
registries:
  "@ax-as": https://registry.example.test/
publicKeys:
  "@ax-as": ""
variables:
  APAX_BUILD_ARGS:
    - --debug
  BIN_FOLDER: "./bin/1500"
dependencies:
  "@ax/simatic-communication": 11.0.2
  "@example/unmapped": 1.2.3
`;
    const filePath = writeApax(content);

    const config = tryParseApax(filePath, createCapturingLogger());

    expect(config).toBeDefined();
    expect(config?.sourcePath).toBe(filePath);
    expect(config?.originalContent).toBe(content);
    expect(config?.original).toMatchObject({
      sdkVersion: "^2510.0.0",
      projectType: "app",
      binFolder: "./bin/1500",
      targets: ["1500", "llvm"],
      buildArgs: ["--debug"],
    });
    expect(config?.original.catalogs).toEqual({
      "@ax/simatic-ax": "^2510.0.0",
      "@example/private": "3.2.1",
    });
    expect(config?.original.dependencies["@ax/simatic-communication"]).toBe("11.0.2");
    expect(config?.original.registries).toEqual({
      "@ax-as": "https://registry.example.test/",
    });
    expect(config?.original.publicKeys).toEqual({ "@ax-as": "" });

    if (config !== undefined) {
      config.migrated.catalogs["@ax/simatic-ax"] = "^2610.0.0";
      expect(config.original.catalogs["@ax/simatic-ax"]).toBe("^2510.0.0");
    }
  });

  it("parses APAX structural keys case-insensitively", () => {
    const filePath = writeApax(`TYPE: app
TARGETS: [s7]
CATALOGS:
  "@ax/simatic-ax": ^2510.0.0
DEPENDENCIES:
  "@ax/ax2tia": ^12.0.0
DEVDEPENDENCIES:
  "@ax/sdk": ^2510.0.0
VARIABLES:
  apax_build_args:
    - --debug # retained
  bin_folder: ./bin/s7
`);

    const config = tryParseApax(filePath, createCapturingLogger());

    expect(config?.original.projectType).toBe("app");
    expect(config?.original.targets).toEqual(["s7"]);
    expect(config?.original.dependencies).toEqual({ "@ax/ax2tia": "^12.0.0" });
    expect(config?.original.devDependencies).toEqual({ "@ax/sdk": "^2510.0.0" });
    expect(config?.original.buildArgs).toEqual(["--debug # retained"]);
    expect(config?.original.binFolder).toBe("./bin/s7");
  });

  it("parses registries and public keys independently", () => {
    const registryConfig = tryParseApax(writeApax(`type: workspace
registries:
  "@ax-as": https://registry.example.test/
`), createCapturingLogger());
    const keyConfig = tryParseApax(writeApax(`type: workspace
publicKeys:
  "@ax-as": key-v1
`), createCapturingLogger());

    expect(registryConfig?.original.registries).toEqual({
      "@ax-as": "https://registry.example.test/",
    });
    expect(registryConfig?.original.publicKeys).toEqual({});
    expect(keyConfig?.original.registries).toEqual({});
    expect(keyConfig?.original.publicKeys).toEqual({ "@ax-as": "key-v1" });
  });

  it.each(["registries", "publicKeys"])("rejects malformed %s", (section) => {
    const logger = createCapturingLogger();
    const filePath = writeApax(`type: workspace
${section}:
  "@ax-as":
    nested: invalid
`);

    expect(tryParseApax(filePath, logger)).toBeUndefined();
    expect(logger.errors).toHaveLength(1);
  });

  it("uses dependency SDK over devDependency with case-insensitive keys", () => {
    const filePath = writeApax(`type: app
targets: [llvm]
catalogs:
  "@AX/SIMATIC-AX": ^2510.0.0
devDependencies:
  "@AX/SDK": ^2510.1.0
dependencies:
  "@ax/SdK": ^2510.2.0
`);

    const config = tryParseApax(filePath, createCapturingLogger());

    expect(config?.original.sdkVersion).toBe("^2510.2.0");
    expect(config?.original.catalogs).toHaveProperty("@AX/SIMATIC-AX", "^2510.0.0");
  });

  it("allows missing build args and BIN_FOLDER", () => {
    const logger = createCapturingLogger();
    const filePath = writeApax(`type: lib
targets:
  - llvm
catalogs:
  "@ax/simatic-ax": ^2510.0.0
dependencies: {}
devDependencies: {}
`);

    const config = tryParseApax(filePath, logger);

    expect(config?.original.buildArgs).toEqual([]);
    expect(config?.original.binFolder).toBe("");
    expect(logger.errors).toEqual([]);
  });

  it("logs the APAX file path when build args are not a sequence", () => {
    const logger = createCapturingLogger();
    const filePath = writeApax(`type: app
targets: [s7]
catalogs:
  "@ax/simatic-ax": ^2510.0.0
variables:
  APAX_BUILD_ARGS:
    -i src
    -o dist
`);

    expect(tryParseApax(filePath, logger)).toBeUndefined();
    expect(logger.errors).toEqual([
      `Failed to read variables.APAX_BUILD_ARGS from APAX configuration: ${filePath}. Expected a YAML sequence.`,
    ]);
  });

  it("allows missing dependency mappings without logging errors", () => {
    const logger = createCapturingLogger();
    const filePath = writeApax(`type: app
targets: [llvm]
catalogs:
  "@ax/simatic-ax": ^2510.0.0
`);

    const config = tryParseApax(filePath, logger);

    expect(config?.original.dependencies).toEqual({});
    expect(config?.original.devDependencies).toEqual({});
    expect(logger.errors).toEqual([]);
  });

  it("reports the APAX file path when targets are missing", () => {
    const logger = createCapturingLogger();
    const filePath = writeApax(`type: app
catalogs:
  "@ax/simatic-ax": ^2510.0.0
`);

    expect(tryParseApax(filePath, logger)).toBeUndefined();
    expect(logger.errors).toEqual([
      `Failed to read targets from APAX configuration: ${filePath}`,
    ]);
  });

  it("appends positional inline comments to build args", () => {
    const filePath = writeApax(`type: app
targets: [llvm]
catalogs:
  "@ax/simatic-ax": ^2510.0.0
dependencies: {}
devDependencies: {}
variables:
  APAX_BUILD_ARGS: # compiler options
    # Comments on their own lines are ignored.
    - --debug # Enable debug information

    - '--output "./artifacts # retained"' # Compiler output
  BIN_FOLDER: ./bin
`);

    const config = tryParseApax(filePath, createCapturingLogger());

    expect(config?.original.buildArgs).toEqual([
      "--debug # Enable debug information",
      '--output "./artifacts # retained" # Compiler output',
    ]);
  });
});

function writeApax(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), "apax-parser-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "apax.yml");
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

function createCapturingLogger(): Logger & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    info: () => undefined,
    warn: () => undefined,
    error: (message) => errors.push(message),
  };
}