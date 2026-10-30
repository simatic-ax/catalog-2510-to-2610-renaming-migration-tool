import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApaxConfig } from "../src/domain/apax-config.js";
import { CliExitCode } from "../src/domain/cli-exit-codes.js";
import { GenerationMode } from "../src/domain/generation.js";
import { CapturingLogger } from "../src/domain/logger.js";
import type { ApaxCommandRunner } from "../src/io/apax-command-runner.js";
import type { ConsoleIO } from "../src/io/console-io.js";
import type { CatalogAcquirer } from "../src/migration/catalog-resolver.js";
import { migrateProject } from "../src/migration/project-migrator.js";

const temporaryDirectories: string[] = [];
const backupFailure = vi.hoisted(() => ({ enabled: false }));
const failedCatalogAcquirer: CatalogAcquirer = async () => undefined;

vi.mock("../src/migration/catalog-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/migration/catalog-resolver.js")>();
  return {
    ...actual,
    acquireCatalog: async (
      _source: unknown,
      options: { name: string; version: string },
    ) => ({
      dependencies: {
        "@ax-as/s7-clocks-lib": "12.0.64-test",
        "@ax-as/system-lib": "11.0.102-test",
      },
      name: options.name,
      version: options.version === "latest" ? "2610.0.0-test" : options.version,
    }),
  };
});

vi.mock("../src/io/apax-command-runner.js", () => ({
  runApaxCommand: vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" }),
}));

vi.mock("../src/io/migration-output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/io/migration-output.js")>();
  return {
    ...actual,
    tryCreateBackup: async (...arguments_: Parameters<typeof actual.tryCreateBackup>) =>
      backupFailure.enabled ? false : actual.tryCreateBackup(...arguments_),
  };
});

afterEach(() => {
  backupFailure.enabled = false;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("migrateProject", () => {
  it("exports src then test files followed by apax.yml and make.yml", async () => {
    const project = createProject();
    const output = join(project, "migrated");
    writeProjectFile(project, "src/Main.st", "Siemens.Simatic.Tasks.Run();");
    writeProjectFile(project, "test/Test.st", "Siemens.Simatic.Tasks.Run();");
    const logger = new CapturingLogger();

    const result = await migrateProject(
      project,
      { outputDirectory: output },
      GenerationMode.Export,
      false,
      new TestConsole(),
      logger,
      createConfig(project),
    );

    expect(result).toBe(CliExitCode.Success);
    expect(readFileSync(join(output, "src", "Main.st"), "utf8")).toBe("Siemens.S7.Tasks.Run();");
    expect(readFileSync(join(output, "test", "Test.st"), "utf8")).toBe("Siemens.S7.Tasks.Run();");
    expect(readFileSync(join(output, "apax.yml"), "utf8"))
      .toContain('"@ax-as/s7-catalog": ^2610.0.0-test');
    expect(existsSync(join(output, "make.yml"))).toBe(true);
    expect(logger.messages.filter((message) => /^(Created|Updated|Unchanged):/.test(message)))
      .toEqual([
        `Created: ${join(output, "src", "Main.st")}`,
        `Created: ${join(output, "test", "Test.st")}`,
        `Created: ${join(output, "apax.yml")}`,
        `Created: ${join(output, "make.yml")}`,
      ]);
  });

  it("recreates unchanged make.yml when replacing an export directory", async () => {
    const project = createProject();
    const output = join(project, "migrated");
    writeProjectFile(project, "src/Main.st", "PROGRAM Main\nEND_PROGRAM");

    const firstResult = await migrateProject(
      project,
      { outputDirectory: output },
      GenerationMode.Export,
      false,
      new TestConsole(),
      new CapturingLogger(),
      createConfig(project),
    );
    const firstMake = readFileSync(join(output, "make.yml"), "utf8");

    const secondResult = await migrateProject(
      project,
      { outputDirectory: output, replaceOutputDirectory: true },
      GenerationMode.Export,
      false,
      new TestConsole(),
      new CapturingLogger(),
      createConfig(project),
    );

    expect(firstResult).toBe(CliExitCode.Success);
    expect(secondResult).toBe(CliExitCode.Success);
    expect(readFileSync(join(output, "make.yml"), "utf8")).toBe(firstMake);
  });

  it("returns validation when neither src nor test exists", async () => {
    const project = temporaryDirectory();
    const logger = new CapturingLogger();

    const result = await migrateProject(
      project,
      { outputDirectory: join(project, "output") },
      GenerationMode.Export,
      false,
      new TestConsole(),
      logger,
      createConfig(project),
    );

    expect(result).toBe(CliExitCode.Validation);
    expect(logger.messages).toEqual([
      `Neither src nor test folder was found in project: ${project}`,
    ]);
  });

  it("writes the resolved catalog with tilde compatibility when selected", async () => {
    const project = createProject();
    const output = join(project, "migrated");
    writeProjectFile(project, "src/Main.st", "PROGRAM Main\nEND_PROGRAM");

    const result = await migrateProject(
      project,
      { outputDirectory: output },
      GenerationMode.Export,
      false,
      new TestConsole(),
      new CapturingLogger(),
      createConfig(project),
      { compatibility: "tilde", name: "@ax-as/s7-catalog", version: "latest" },
    );

    expect(result).toBe(CliExitCode.Success);
    expect(readFileSync(join(output, "apax.yml"), "utf8"))
      .toContain('"@ax-as/s7-catalog": ~2610.0.0-test');
  });

  it("returns migration for an unsupported catalog without writing output", async () => {
    const project = createProject();
    mkdirSync(join(project, "src"));
    const output = join(project, "output");
    const config = createConfig(project, "^2610.0.0");

    const result = await migrateProject(
      project,
      { outputDirectory: output },
      GenerationMode.Export,
      false,
      new TestConsole(),
      new CapturingLogger(),
      config,
    );

    expect(result).toBe(CliExitCode.Migration);
    expect(existsSync(output)).toBe(false);
    expect(config.migrated.catalogs).toEqual({ "@ax/simatic-ax": "^2610.0.0" });
  });

  it("creates a backup before successful overwrite and retains BIN_FOLDER", async () => {
    const project = createProject();
    writeProjectFile(project, "src/Main.st", "Siemens.Simatic.Tasks.Run();");
    writeProjectFile(project, "make.yml", "old make");

    const result = await migrateProject(
      project,
      { outputDirectory: project },
      GenerationMode.Overwrite,
      false,
      new TestConsole(["all"]),
      new CapturingLogger(),
      createConfig(project),
    );

    expect(result).toBe(CliExitCode.Success);
    expect(readFileSync(join(project, "src", "Main.st"), "utf8")).toBe("Siemens.S7.Tasks.Run();");
    expect(readFileSync(join(project, "apax.yml"), "utf8")).toContain('BIN_FOLDER: "./bin/1500"');
    expect(readdirSync(project).some((name) =>
      new RegExp(`^${escapeRegex(basename(project))}_\\d{8}_\\d{6}\\.zip$`).test(name)
    )).toBe(true);
  });

  it("does not create make.yml when the apax.yml overwrite is declined", async () => {
    const project = createProject();
    writeProjectFile(project, "src/Main.st", "PROGRAM Main\nEND_PROGRAM");
    const logger = new CapturingLogger();

    const result = await migrateProject(
      project,
      { outputDirectory: project },
      GenerationMode.Overwrite,
      true,
      new TestConsole(["n"]),
      logger,
      createConfig(project),
    );

    expect(result).toBe(CliExitCode.Success);
    expect(existsSync(join(project, "make.yml"))).toBe(false);
    expect(logger.messages).toContain(
      `Skipped creating file: ${join(project, "make.yml")}`,
    );
  });

  it("returns I/O failure without writing when overwrite backup fails", async () => {
    const project = createProject();
    const sourcePath = join(project, "src", "Main.st");
    const originalContent = "Siemens.Simatic.Tasks.Run();";
    writeProjectFile(project, "src/Main.st", originalContent);
    backupFailure.enabled = true;

    const result = await migrateProject(
      project,
      { outputDirectory: project },
      GenerationMode.Overwrite,
      false,
      new TestConsole(["all"]),
      new CapturingLogger(),
      createConfig(project),
    );

    expect(result).toBe(CliExitCode.Io);
    expect(readFileSync(sourcePath, "utf8")).toBe(originalContent);
    expect(existsSync(join(project, "make.yml"))).toBe(false);
  });

  it("skips backup in overwrite mode when requested", async () => {
    const project = createProject();
    writeProjectFile(project, "src/Main.st", "Siemens.Simatic.Tasks.Run();");

    const result = await migrateProject(
      project,
      { outputDirectory: project },
      GenerationMode.Overwrite,
      true,
      new TestConsole(["all"]),
      new CapturingLogger(),
      createConfig(project),
    );

    expect(result).toBe(CliExitCode.Success);
    expect(readdirSync(project).some((name) => name.endsWith(".zip"))).toBe(false);
  });

  it("applies catalog versions and resolves only non-catalog packages before writing", async () => {
    const project = createProject();
    const output = join(project, "migrated");
    writeProjectFile(project, "src/Main.st", "PROGRAM Main\nEND_PROGRAM");
    const config = createApaxConfig({
      projectType: "lib",
      catalogs: { "@ax/simatic-ax": "^2510.0.0" },
      dependencies: { "@ax/simatic-clocks": "11.0.116" },
      devDependencies: { "@ax/axunitst-make": "^8.1.0" },
    }, join(project, "apax.yml"), apaxContent());
    const calls: readonly string[][] = [];
    const acquireCatalog: CatalogAcquirer = async (_source, options) => {
      (calls as string[][]).push(["add", "--catalog", `${options.name}@${options.version}`]);
      expect(existsSync(output)).toBe(false);
      return {
        dependencies: { "@ax-as/s7-clocks-lib": "12.0.64-test" },
        name: options.name,
        version: options.version,
      };
    };
    const runApax: ApaxCommandRunner = async (arguments_, workingDirectory) => {
      (calls as string[][]).push([...arguments_]);
      expect(arguments_[0]).toBe("list");
      expect(workingDirectory).toBe(project);
      expect(existsSync(join(output, "apax.yml"))).toBe(false);
      return { exitCode: 0, stderr: "", stdout: "9.6.6\n" };
    };

    const result = await migrateProject(
      project,
      { outputDirectory: output },
      GenerationMode.Export,
      false,
      new TestConsole(),
      new CapturingLogger(),
      config,
      { compatibility: "exact", name: "@example/custom-catalog", version: "2610.0.0-rc.1" },
      runApax,
      undefined,
      undefined,
      acquireCatalog,
    );

    expect(result).toBe(CliExitCode.Success);
    expect(calls).toEqual([
      ["add", "--catalog", "@example/custom-catalog@2610.0.0-rc.1"],
      ["list", "-p", "@ax-as/axunit-make"],
    ]);
    expect(readFileSync(join(output, "apax.yml"), "utf8"))
      .toContain('"@ax-as/axunit-make": ^9.6.6');
    expect(readFileSync(join(output, "apax.yml"), "utf8"))
      .toContain('"@ax-as/s7-clocks-lib": 12.0.64-test');
    expect(readFileSync(join(output, "apax.yml"), "utf8"))
      .toContain('"@example/custom-catalog": 2610.0.0-rc.1');
  });

  it("keeps a migrated package in both dependency sections", async () => {
    const project = createProject();
    const output = join(project, "migrated");
    writeProjectFile(project, "src/Main.st", "PROGRAM Main\nEND_PROGRAM");
    const config = createApaxConfig({
      projectType: "lib",
      catalogs: { "@ax/simatic-ax": "^2510.0.0" },
      dependencies: { "@ax/system": "^10.0.0" },
      devDependencies: { "@AX/SYSTEM": "^10.0.0" },
    }, join(project, "apax.yml"), apaxContent());
    const logger = new CapturingLogger();
    const runApax = vi.fn<ApaxCommandRunner>();

    const result = await migrateProject(
      project,
      { outputDirectory: output },
      GenerationMode.Export,
      false,
      new TestConsole(),
      logger,
      config,
      undefined,
      runApax,
    );

    expect(result).toBe(CliExitCode.Success);
    expect(runApax).not.toHaveBeenCalled();
    const migratedApax = readFileSync(join(output, "apax.yml"), "utf8");
    expect(migratedApax).toContain('"@ax-as/system-lib": ^11.0.102-test');
    expect(migratedApax.match(/"@ax-as\/system-lib"/gu)).toHaveLength(2);
    expect(migratedApax).toContain("devDependencies:");
    expect(logger.messages).not.toContain(
      "Removed duplicate packages from devDependencies: @ax-as/system-lib",
    );
  });

  it("validates the catalog without changing apax.yml when overwrite is declined", async () => {
    const project = createProject();
    mkdirSync(join(project, "src"));
    const logger = new CapturingLogger();
    const runApax = vi.fn<ApaxCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: "",
    });
    const originalContent = readFileSync(join(project, "apax.yml"), "utf8");

    const result = await migrateProject(
      project,
      { outputDirectory: project },
      GenerationMode.Overwrite,
      true,
      new TestConsole(["n"]),
      logger,
      createConfig(project),
      { compatibility: "caret", name: "@ax-as/s7-catalog", version: "latest" },
      runApax,
    );

    expect(result).toBe(CliExitCode.Success);
    expect(runApax).not.toHaveBeenCalled();
    expect(readFileSync(join(project, "apax.yml"), "utf8")).toBe(originalContent);
  });

  it("writes latest and continues when apax list fails", async () => {
      const project = createProject();
      const output = join(project, "migrated");
      writeProjectFile(project, "src/Main.st", "Siemens.Simatic.Tasks.Run();");
      const config = createApaxConfig({
        projectType: "lib",
        catalogs: { "@ax/simatic-ax": "^2510.0.0" },
        devDependencies: { "@ax/axunitst-make": "^8.1.0" },
      }, join(project, "apax.yml"), apaxContent());
      const runApax: ApaxCommandRunner = async () => ({
        exitCode: 1,
        stderr: "failed",
        stdout: "",
      });

      const result = await migrateProject(
        project,
        { outputDirectory: output },
        GenerationMode.Export,
        false,
        new TestConsole(),
        new CapturingLogger(),
        config,
        undefined,
        runApax,
        undefined,
        undefined,
      );

      expect(result).toBe(CliExitCode.Success);
      expect(readFileSync(join(output, "apax.yml"), "utf8"))
        .toContain('"@ax-as/axunit-make": latest');
  });

  it("does not create export output when apax add fails", async () => {
    const project = createProject();
    const output = join(project, "migrated");
    writeProjectFile(project, "src/Main.st", "Siemens.Simatic.Tasks.Run();");

    const result = await migrateProject(
      project,
      { outputDirectory: output },
      GenerationMode.Export,
      false,
      new TestConsole(),
      new CapturingLogger(),
      createConfig(project),
      undefined,
      undefined,
      undefined,
      undefined,
      failedCatalogAcquirer,
    );

    expect(result).toBe(CliExitCode.Migration);
    expect(existsSync(output)).toBe(false);
  });

  it("leaves overwrite files and backups unchanged when apax add fails", async () => {
    const project = createProject();
    const sourcePath = join(project, "src", "Main.st");
    const originalSource = "Siemens.Simatic.Tasks.Run();";
    const originalApax = readFileSync(join(project, "apax.yml"), "utf8");
    writeProjectFile(project, "src/Main.st", originalSource);
    const runApax = vi.fn<ApaxCommandRunner>().mockResolvedValue({
      exitCode: 1,
      stderr: "failed",
      stdout: "",
    });

    const result = await migrateProject(
      project,
      { outputDirectory: project },
      GenerationMode.Overwrite,
      false,
      new TestConsole(["all"]),
      new CapturingLogger(),
      createConfig(project),
      undefined,
      runApax,
      undefined,
      undefined,
      failedCatalogAcquirer,
    );

    expect(result).toBe(CliExitCode.Migration);
    expect(readFileSync(sourcePath, "utf8")).toBe(originalSource);
    expect(readFileSync(join(project, "apax.yml"), "utf8")).toBe(originalApax);
    expect(existsSync(join(project, "make.yml"))).toBe(false);
    expect(readdirSync(project).some((name) => name.endsWith(".zip"))).toBe(false);
  });

  it("preserves a confirmed non-empty export destination when apax add fails", async () => {
    const project = createProject();
    const output = join(project, "migrated");
    const stalePath = join(output, "stale.txt");
    writeProjectFile(project, "src/Main.st", "Siemens.Simatic.Tasks.Run();");
    writeProjectFile(project, "migrated/stale.txt", "keep");
    const runApax = vi.fn<ApaxCommandRunner>().mockResolvedValue({
      exitCode: 1,
      stderr: "failed",
      stdout: "",
    });

    const result = await migrateProject(
      project,
      { outputDirectory: output, replaceOutputDirectory: true },
      GenerationMode.Export,
      false,
      new TestConsole(),
      new CapturingLogger(),
      createConfig(project),
      undefined,
      runApax,
      undefined,
      undefined,
      failedCatalogAcquirer,
    );

    expect(result).toBe(CliExitCode.Migration);
    expect(readdirSync(output)).toEqual(["stale.txt"]);
    expect(readFileSync(stalePath, "utf8")).toBe("keep");
  });
});

class TestConsole implements ConsoleIO {
  constructor(private readonly answers: string[] = []) {}

  async readLine(): Promise<string | undefined> {
    return this.answers.shift();
  }

  writeError(): void {}
}

function createProject(): string {
  const project = temporaryDirectory();
  writeProjectFile(project, "apax.yml", apaxContent());
  return project;
}

function createConfig(project: string, catalog = "^2510.0.0") {
  const content = apaxContent(catalog);
  return createApaxConfig({
    projectType: "lib",
    catalogs: { "@ax/simatic-ax": catalog },
    targets: ["1500"],
    binFolder: "./bin/1500",
  }, join(project, "apax.yml"), content);
}

function apaxContent(catalog = "^2510.0.0"): string {
  return [
    "type: lib",
    "catalogs:",
    `  \"@ax/simatic-ax\": ${catalog}`,
    "targets:",
    "  - 1500",
    "variables:",
    '  BIN_FOLDER: "./bin/1500"',
    "",
  ].join("\n");
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "project-migrator-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeProjectFile(project: string, relativePath: string, content: string): void {
  const path = join(project, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}