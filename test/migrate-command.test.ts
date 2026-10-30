import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeMigrateCommand,
  getResourceBusyMessage,
} from "../src/commands/migrate-command.js";
import { CliExitCode } from "../src/domain/cli-exit-codes.js";
import { CapturingLogger } from "../src/domain/logger.js";
import type { ApaxCommandRunner } from "../src/io/apax-command-runner.js";
import type { ConsoleIO } from "../src/io/console-io.js";
import type { CatalogAcquirer } from "../src/migration/catalog-resolver.js";

const temporaryDirectories: string[] = [];
const successfulApaxRunner: ApaxCommandRunner = async () => ({
  exitCode: 0,
  stderr: "",
  stdout: "",
});
const successfulCatalogAcquirer: CatalogAcquirer = async (_source, options) => ({
  dependencies: {
    "@ax-as/s7-communication-lib": "12.0.0-test",
    "@ax-as/s7-sdk": "2610.0.0-test",
  },
  name: options.name,
  version: options.version === "latest" ? "2610.0.0-test" : options.version,
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("executeMigrateCommand", () => {
  it("explains how to recover from a busy output path", () => {
    const error = new Error("resource busy") as NodeJS.ErrnoException;
    error.code = "EBUSY";
    error.path = "G:\\temp\\migrationtest\\migrated_project";

    expect(getResourceBusyMessage(error)).toBe(
      "Resource busy or locked: cannot update output at 'G:\\temp\\migrationtest\\migrated_project'. Close any application using this path and try again.",
    );
  });

  it.each(["app", "LIB"])("migrates a root %s project", async (projectType) => {
    const project = temporaryDirectory();
    writeValidProject(project, ".", "^2510.0.0", projectType);

    const result = await execute(project);

    expect(result.code).toBe(CliExitCode.Success);
    expect(existsSync(join(project, "migrated_project/apax.yml"))).toBe(true);
    expect(existsSync(join(project, "migrated_project/src/Main.st"))).toBe(true);
  });

  it("exports valid direct children and ignores invalid, excluded, and nested folders", async () => {
    const workspace = createWorkspace();
    writeValidProject(workspace, "alpha");
    writeFile(workspace, "broken/apax.yml", "type: app");
    writeValidProject(workspace, "charlie");
    writeValidProject(workspace, ".apax/ignored");
    writeValidProject(workspace, ".vscode/ignored");
    writeValidProject(workspace, ".ax/ignored");
    writeValidProject(workspace, "container/nested");

    const result = await execute(workspace);

    expect(result.code).toBe(CliExitCode.Success);
    expect(existsSync(join(workspace, "alpha/migrated_project/apax.yml"))).toBe(true);
    expect(existsSync(join(workspace, "alpha/migrated_project/make.yml"))).toBe(true);
    expect(existsSync(join(workspace, "alpha/migrated_project/src/Main.st"))).toBe(true);
    expect(existsSync(join(workspace, "charlie/migrated_project/apax.yml"))).toBe(true);
    expect(existsSync(join(workspace, ".apax/ignored/migrated_project"))).toBe(false);
    expect(existsSync(join(workspace, ".vscode/ignored/migrated_project"))).toBe(false);
    expect(existsSync(join(workspace, ".ax/ignored/migrated_project"))).toBe(false);
    expect(existsSync(join(workspace, "container/nested/migrated_project"))).toBe(false);
    expect(existsSync(join(workspace, "migrated_project"))).toBe(false);
    expect(result.logger.messages).toContain(
      "Workspace migration completed. Succeeded: 2, failed: 0.",
    );
  });

  it("selects discovered projects only when run from the workspace root", async () => {
    const workspace = createWorkspace();
    writeValidProject(workspace, "alpha");
    writeValidProject(workspace, "beta");
    const consoleIO = new TestConsole("", "2");

    const result = await execute(workspace, {}, consoleIO);

    expect(result.code).toBe(CliExitCode.Success);
    expect(consoleIO.error).toContain(`Workspace projects: ${workspace}`);
    expect(consoleIO.error).toContain("1. alpha");
    expect(consoleIO.error).toContain("2. beta");
    expect(consoleIO.error).toContain(
      "Select projects: Enter project numbers separated by commas, or [a]ll projects:",
    );
    expect(result.logger.messages).toContain(
      "Invalid selection. Enter project numbers separated by commas, or a for all projects.",
    );
    expect(existsSync(join(workspace, "alpha/migrated_project"))).toBe(false);
    expect(existsSync(join(workspace, "beta/migrated_project/apax.yml"))).toBe(true);
  });

  it("selects all workspace projects without prompting when prompts are accepted", async () => {
    const workspace = createWorkspace();
    writeValidProject(workspace, "alpha");
    writeValidProject(workspace, "beta");
    const consoleIO = new TestConsole();

    const result = await execute(workspace, { acceptAllPrompts: true }, consoleIO);

    expect(result.code).toBe(CliExitCode.Success);
    expect(consoleIO.error).toBe("");
    expect(existsSync(join(workspace, "alpha/migrated_project/apax.yml"))).toBe(true);
    expect(existsSync(join(workspace, "beta/migrated_project/apax.yml"))).toBe(true);
  });

  it("migrates only the current project when run from a workspace child", async () => {
    const workspace = createWorkspace();
    writeValidProject(workspace, "alpha");
    writeValidProject(workspace, "beta", "^2510.0.0", "lib");
    const consoleIO = new TestConsole("all");

    const result = await execute(join(workspace, "alpha"), {}, consoleIO);

    expect(result.code).toBe(CliExitCode.Success);
    expect(existsSync(join(workspace, "alpha/migrated_project/apax.yml"))).toBe(true);
    expect(existsSync(join(workspace, "beta/migrated_project"))).toBe(false);
    expect(consoleIO.error).not.toContain("Workspace detected:");
  });

  it("does not acquire or discover sibling projects when run from a workspace child", async () => {
    const workspace = createWorkspace();
    writeValidProject(workspace, "alpha");
    writeValidProject(workspace, "beta");
    let acquisitionCount = 0;
    let discoveryCount = 0;
    const acquireCatalog: CatalogAcquirer = async (source, options) => {
      acquisitionCount++;
      return successfulCatalogAcquirer(source, options, successfulApaxRunner, new CapturingLogger());
    };

    const logger = new CapturingLogger();
    const code = await executeMigrateCommand({}, {
      currentDirectory: () => join(workspace, "alpha"),
      consoleIO: new TestConsole("all"),
      logger,
      runApax: successfulApaxRunner,
      acquireCatalog,
      discoverProjects: () => {
        discoveryCount++;
        return [join(workspace, "alpha"), join(workspace, "beta")];
      },
    });

    expect(code).toBe(CliExitCode.Success);
    expect(acquisitionCount).toBe(1);
    expect(discoveryCount).toBe(0);
    expect(existsSync(join(workspace, "alpha/migrated_project/apax.yml"))).toBe(true);
    expect(existsSync(join(workspace, "beta/migrated_project"))).toBe(false);
  });

  it("stops immediately and writes no workspace output when catalog acquisition fails", async () => {
    const workspace = createWorkspace();
    writeValidProject(workspace, "alpha");
    writeValidProject(workspace, "beta");
    const logger = new CapturingLogger();
    let acquisitionCount = 0;
    const acquireCatalog: CatalogAcquirer = async (_source, options) => {
      acquisitionCount++;
      return acquisitionCount === 1
        ? undefined
        : { dependencies: {}, name: options.name, version: options.version };
    };

    const code = await executeMigrateCommand({}, {
      currentDirectory: () => workspace,
      consoleIO: new TestConsole("a"),
      logger,
      acquireCatalog,
    });

    expect(code).toBe(CliExitCode.Migration);
    expect(existsSync(join(workspace, "alpha/migrated_project"))).toBe(false);
    expect(existsSync(join(workspace, "beta/migrated_project"))).toBe(false);
    expect(acquisitionCount).toBe(1);
        expect(logger.messages).toContain(
          "Workspace migration was not migrated because catalog acquisition failed.",
        );
  });

  it("migrates a nested app as one project without inspecting its ancestors", async () => {
    const workspace = createWorkspace();
    writeValidProject(workspace, "alpha");
    writeValidProject(workspace, "container/nested");

    const result = await execute(join(workspace, "container/nested"));

    expect(result.code).toBe(CliExitCode.Success);
    expect(existsSync(join(workspace, "container/nested/migrated_project/apax.yml"))).toBe(true);
    expect(existsSync(join(workspace, "alpha/migrated_project"))).toBe(false);
  });

  it("uses standalone output path handling when run from a workspace child", async () => {
    const workspace = createWorkspace();
    writeValidProject(workspace, "alpha");
    writeValidProject(workspace, "beta");

    const result = await execute(
      join(workspace, "alpha"),
      { outputPath: "../outside" },
      new TestConsole(""),
    );

    expect(result.code).toBe(CliExitCode.Success);
    expect(existsSync(join(workspace, "outside/apax.yml"))).toBe(true);
    expect(existsSync(join(workspace, "beta/migrated_project"))).toBe(false);
  });

  it("uses a custom relative output folder inside each child", async () => {
    const workspace = createWorkspace();
    writeValidProject(workspace, "alpha");
    writeValidProject(workspace, "beta");

    const result = await execute(workspace, { outputPath: "migration/2610" });

    expect(result.code).toBe(CliExitCode.Success);
    expect(existsSync(join(workspace, "alpha/migration/2610/apax.yml"))).toBe(true);
    expect(existsSync(join(workspace, "beta/migration/2610/apax.yml"))).toBe(true);
  });

  it("replaces confirmed non-empty output and preserves declined output", async () => {
    const confirmed = createWorkspace();
    writeValidProject(confirmed, "alpha");
    writeFile(confirmed, "alpha/migrated_project/stale.txt", "stale");
    const yesConsole = new TestConsole("yes");

    expect((await execute(confirmed, {}, yesConsole)).code).toBe(CliExitCode.Success);
    expect(existsSync(join(confirmed, "alpha/migrated_project/stale.txt"))).toBe(false);
    expect(yesConsole.error).toContain("Delete its contents and continue? [y/N]");

    const declined = createWorkspace();
    writeValidProject(declined, "alpha");
    writeFile(declined, "alpha/migrated_project/stale.txt", "stale");

    expect((await execute(declined, {}, new TestConsole("n"))).code)
      .toBe(CliExitCode.Validation);
    expect(existsSync(join(declined, "alpha/migrated_project/stale.txt"))).toBe(true);
    expect(existsSync(join(declined, "alpha/migrated_project/apax.yml"))).toBe(false);
  });

  it("rejects absolute and escaping workspace output paths", async () => {
    const workspace = createWorkspace();
    writeValidProject(workspace, "alpha");

    expect((await execute(workspace, { outputPath: join(workspace, "output") })).code)
      .toBe(CliExitCode.Validation);
    expect((await execute(workspace, { outputPath: "../output" })).code)
      .toBe(CliExitCode.Validation);
    expect(existsSync(join(workspace, "alpha/migrated_project"))).toBe(false);
  });

  it("accepts case-insensitive modes and creates overwrite backups per child", async () => {
    const workspace = createWorkspace();
    writeValidProject(workspace, "alpha");
    writeValidProject(workspace, "beta");

    const result = await execute(workspace, { mode: "oVeRwRiTe" }, new TestConsole("a", "a"));

    expect(result.code).toBe(CliExitCode.Success);
    expect(result.logger.messages.filter((message) => message.includes("Created overwrite backup archive")))
      .toHaveLength(2);
  });

  it("sorts valid projects case-insensitively and excludes invalid projects", async () => {
    const workspace = createWorkspace();
    writeFile(workspace, "broken/apax.yml", "type: app");
    writeValidProject(workspace, "Alpha");
    writeValidProject(workspace, "charlie");
    const result = await execute(workspace);

    expect(result.logger.messages.filter((message) => message.startsWith("Starting to migrate:")))
      .toEqual(["Starting to migrate: Alpha", "Starting to migrate: charlie"]);
    expect(existsSync(join(workspace, "broken/migrated_project"))).toBe(false);
  });

  it("returns usage for invalid mode and migration for unsupported catalog", async () => {
    const workspace = createWorkspace();
    writeValidProject(workspace, "alpha", "^2410.0.0");

    expect((await execute(workspace, { mode: "invalid" })).code).toBe(CliExitCode.Usage);
    expect((await execute(workspace)).code).toBe(CliExitCode.Migration);
    expect(existsSync(join(workspace, "alpha/migrated_project/apax.yml"))).toBe(false);
  });

  it("returns validation when a workspace has no direct child projects", async () => {
    const workspace = createWorkspace();
    const result = await execute(workspace);

    expect(result.code).toBe(CliExitCode.Validation);
    expect(result.logger.messages).toContain(
      `No direct app or lib projects were found in workspace: ${workspace}`,
    );
  });

  it("excludes unsupported workspace child types", async () => {
    const workspace = createWorkspace();
    writeValidProject(workspace, "alpha");
    const unsupportedApaxPath = join(workspace, "workspace-child/apax.yml");
    writeFile(workspace, "workspace-child/apax.yml", "type: workspace");

    const result = await execute(workspace);

    expect(result.code).toBe(CliExitCode.Success);
    expect(result.logger.messages).toContain(
      `Unsupported workspace child project type 'workspace' in ${unsupportedApaxPath}. Expected app or lib. Skipping project.`,
    );
    expect(existsSync(join(workspace, "alpha/migrated_project/apax.yml"))).toBe(true);
    expect(existsSync(join(workspace, "workspace-child/migrated_project"))).toBe(false);
  });

  it("logs the child apax.yml path when workspace targets are missing", async () => {
    const workspace = createWorkspace();
    writeValidProject(workspace, "alpha");
    const invalidApaxPath = join(workspace, "beta/apax.yml");
    writeFile(workspace, "beta/apax.yml", [
      "type: lib",
      "catalogs:",
      '  "@ax/simatic-ax": "^2510.0.0"',
    ].join("\n"));

    const result = await execute(workspace);

    expect(result.code).toBe(CliExitCode.Success);
    expect(result.logger.messages).toContain(
      `Failed to read targets from APAX configuration: ${invalidApaxPath}`,
    );
    expect(existsSync(join(workspace, "alpha/migrated_project/apax.yml"))).toBe(true);
    expect(existsSync(join(workspace, "beta/migrated_project"))).toBe(false);
  });

  it("stops after the first child exception", async () => {
    const workspace = createWorkspace();
    writeValidProject(workspace, "alpha");
    writeValidProject(workspace, "beta");
    const logger = new CapturingLogger();
    const migratedProjects: string[] = [];

    const code = await executeMigrateCommand({}, {
      currentDirectory: () => workspace,
      consoleIO: new TestConsole("a"),
      logger,
      acquireCatalog: successfulCatalogAcquirer,
      migrateProject: async (projectDirectory) => {
        migratedProjects.push(projectDirectory);
        if (projectDirectory.endsWith("alpha")) {
          const error = new Error("disk failed") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        }
        throw new Error("migration failed");
      },
    });

    expect(code).toBe(CliExitCode.Io);
    expect(migratedProjects).toEqual([join(workspace, "alpha")]);
    expect(logger.messages).toContain(
      `I/O operation failed while migrating ${join(workspace, "alpha")}: disk failed`,
    );
    expect(logger.messages).not.toContain(
      `Failed to migrate workspace child project ${join(workspace, "beta")}: migration failed`,
    );
  });

  it("forwards the selected catalog version and compatibility", async () => {
    const project = temporaryDirectory();
    writeValidProject(project, ".");
    let receivedCatalogOptions: unknown;

    const code = await executeMigrateCommand(
      { catalog: "@example/custom-catalog@2610.0.0-rc.1", tilde: true },
      {
        currentDirectory: () => project,
        consoleIO: new TestConsole(),
        logger: new CapturingLogger(),
        migrateProject: async (...arguments_) => {
          receivedCatalogOptions = arguments_[7];
          return CliExitCode.Success;
        },
        runApax: successfulApaxRunner,
      },
    );

    expect(code).toBe(CliExitCode.Success);
    expect(receivedCatalogOptions).toEqual({
      compatibility: "tilde",
      name: "@example/custom-catalog",
      version: "2610.0.0-rc.1",
    });
  });

  it.each([
    ["^2510.0.0", "caret"],
    ["~2510.0.0", "tilde"],
    ["2510.0.0", "exact"],
  ] as const)("inherits %s source catalog compatibility as %s", async (
    sourceVersion,
    expectedCompatibility,
  ) => {
    const project = temporaryDirectory();
    writeValidProject(project, ".", sourceVersion);
    let receivedCatalogOptions: unknown;

    const code = await executeMigrateCommand({}, {
      currentDirectory: () => project,
      consoleIO: new TestConsole(),
      logger: new CapturingLogger(),
      migrateProject: async (...arguments_) => {
        receivedCatalogOptions = arguments_[7];
        return CliExitCode.Success;
      },
    });

    expect(code).toBe(CliExitCode.Success);
    expect(receivedCatalogOptions).toEqual({
      compatibility: expectedCompatibility,
      name: "@ax-as/s7-catalog",
      version: "latest",
    });
  });
});

async function execute(
  directory: string,
  options: {
    acceptAllPrompts?: boolean;
    catalog?: string;
    caret?: boolean;
    exact?: boolean;
    outputPath?: string;
    mode?: string;
    skipBackup?: boolean;
    tilde?: boolean;
  } = {},
  consoleIO: ConsoleIO = new TestConsole("a"),
): Promise<{ code: CliExitCode; logger: CapturingLogger }> {
  const logger = new CapturingLogger();
  const code = await executeMigrateCommand(options, {
    currentDirectory: () => directory,
    consoleIO,
    logger,
    runApax: successfulApaxRunner,
    acquireCatalog: successfulCatalogAcquirer,
  });
  return { code, logger };
}

function createWorkspace(): string {
  const directory = temporaryDirectory();
  writeFile(directory, "apax.yml", "type: workspace");
  return directory;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "migrate-command-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeValidProject(
  workspace: string,
  relativeDirectory: string,
  catalogVersion = "^2510.0.0",
  projectType = "app",
): void {
  writeFile(workspace, `${relativeDirectory}/apax.yml`, [
    "name: workspace-child",
    `type: ${projectType}`,
    "targets:",
    "  - \"1500\"",
    "catalogs:",
    `  \"@ax/simatic-ax\": \"${catalogVersion}\"`,
    "dependencies:",
    "  \"@ax/simatic-communication\": \"11.0.2\"",
    "devDependencies:",
    "  \"@ax/sdk\": \"^2510.0.0\"",
    "variables:",
    "  BIN_FOLDER: \"./bin/1500\"",
  ].join("\n"));
  writeFile(
    workspace,
    `${relativeDirectory}/src/Main.st`,
    "USING Siemens.Simatic.Communication;\nPROGRAM Main\nEND_PROGRAM",
  );
}

function writeFile(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

class TestConsole implements ConsoleIO {
  readonly errorMessages: string[] = [];
  readonly responses: string[];

  constructor(...responses: string[]) {
    this.responses = responses;
  }

  get error(): string {
    return this.errorMessages.join("");
  }

  async readLine(): Promise<string | undefined> {
    return this.responses.shift();
  }

  writeError(message: string): void {
    this.errorMessages.push(message);
  }
}