import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GenerationMode } from "../src/domain/generation.js";
import { CapturingLogger } from "../src/domain/logger.js";
import type { MigratedFile } from "../src/domain/migrated-file.js";
import type { ConsoleIO } from "../src/io/console-io.js";
import {
  tryCreateBackup,
  tryPrepareExportTarget,
  tryPrepareTarget,
  tryValidateWorkspaceOutputPath,
  writeMigrationOutput,
} from "../src/io/migration-output.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("migration output targets", () => {
  it("returns an explicit export directory without creating it", async () => {
    const directory = temporaryDirectory();
    const outputDirectory = join(directory, "new", "output");

    const target = await tryPrepareExportTarget(outputDirectory, new TestConsole(), new CapturingLogger());

    expect(target).toEqual({ outputDirectory });
    expect(existsSync(outputDirectory)).toBe(false);
  });

  it("preserves a non-empty export directory when clearing is declined", async () => {
    const outputDirectory = temporaryDirectory();
    const stalePath = join(outputDirectory, "stale.txt");
    writeFileSync(stalePath, "keep", "utf8");
    const consoleIO = new TestConsole(["no"]);
    const logger = new CapturingLogger();

    const target = await tryPrepareExportTarget(outputDirectory, consoleIO, logger);

    expect(target).toBeUndefined();
    expect(readFileSync(stalePath, "utf8")).toBe("keep");
    expect(consoleIO.error).toContain("Delete its contents and continue? [y/N]\n");
    expect(logger.messages).toContain("Migration cancelled. The output directory was not changed.");
  });

  it.each(["y", "YES"])("defers clearing a non-empty export directory for %s", async (answer) => {
    const outputDirectory = temporaryDirectory();
    writeFileSync(join(outputDirectory, "stale.txt"), "remove", "utf8");

    const target = await tryPrepareExportTarget(
      outputDirectory,
      new TestConsole([answer]),
      new CapturingLogger(),
    );

    expect(target).toEqual({ outputDirectory, replaceOutputDirectory: true });
    expect(readdirSync(outputDirectory)).toEqual(["stale.txt"]);
  });

  it("accepts replacing a non-empty export directory without prompting", async () => {
    const outputDirectory = temporaryDirectory();
    writeFileSync(join(outputDirectory, "stale.txt"), "remove", "utf8");
    const consoleIO = new TestConsole();

    const target = await tryPrepareExportTarget(
      outputDirectory,
      consoleIO,
      new CapturingLogger(),
      true,
    );

    expect(target).toEqual({ outputDirectory, replaceOutputDirectory: true });
    expect(consoleIO.prompts).toEqual([]);
  });

  it("selects the project for overwrite mode and warns", async () => {
    const projectDirectory = temporaryDirectory();
    const logger = new CapturingLogger();

    const target = await tryPrepareTarget(
      projectDirectory,
      undefined,
      GenerationMode.Overwrite,
      new TestConsole(),
      logger,
    );

    expect(target).toEqual({ outputDirectory: projectDirectory });
    expect(logger.entries).toContainEqual({
      level: "warning",
      message: "Overwrite mode selected: files will be overwritten in the original project.",
    });
  });
});

describe("workspace output validation", () => {
  it.each([undefined, "", "generated", "nested/output"])("accepts an internal path: %s", (path) => {
    expect(tryValidateWorkspaceOutputPath(path, new CapturingLogger())).toBe(true);
  });

  it.each([resolve(tmpdir(), "outside"), ".", "child/..", "../outside"])(
    "rejects a path that is absolute or does not resolve inside the project: %s",
    (path) => {
      const logger = new CapturingLogger();

      expect(tryValidateWorkspaceOutputPath(path, logger)).toBe(false);
      expect(logger.entries.at(-1)?.level).toBe("error");
      expect(logger.messages.at(-1)).toContain("Workspace output");
    },
  );
});

describe("writing migrated files", () => {
  it("reports created, updated, and explicitly unchanged export files", async () => {
    const directory = temporaryDirectory();
    const updatedPath = join(directory, "updated.txt");
    const createdPath = join(directory, "nested", "created.txt");
    const unchangedPath = join(directory, "unchanged.txt");
    writeFileSync(updatedPath, "old", "utf8");
    writeFileSync(unchangedPath, "same", "utf8");
    const logger = new CapturingLogger();

    await writeMigrationOutput([
      migratedFile(createdPath, "new"),
      migratedFile(updatedPath, "updated"),
      migratedFile(unchangedPath, "same", false, true),
      migratedFile(join(directory, "silent.txt"), "same", false, false),
    ], GenerationMode.Export, new TestConsole(), logger, "app");

    expect(readFileSync(createdPath, "utf8")).toBe("new");
    expect(readFileSync(updatedPath, "utf8")).toBe("updated");
    expect(logger.messages).toEqual([
      "Migrated files overview for app (3 files):",
      `Created: ${createdPath}`,
      `Updated: ${updatedPath}`,
      `Unchanged: ${unchangedPath}`,
    ]);
  });

  it("loops on invalid overwrite answers, skips no, and prompts again for yes", async () => {
    const directory = temporaryDirectory();
    const firstPath = join(directory, "first.txt");
    const secondPath = join(directory, "second.txt");
    writeFileSync(firstPath, "old", "utf8");
    writeFileSync(secondPath, "old", "utf8");
    const consoleIO = new TestConsole(["maybe", "n", "yes"]);
    const logger = new CapturingLogger();

    await writeMigrationOutput([
      migratedFile(firstPath, "new"),
      migratedFile(secondPath, "new"),
    ], GenerationMode.Overwrite, consoleIO, logger);

    expect(readFileSync(firstPath, "utf8")).toBe("old");
    expect(readFileSync(secondPath, "utf8")).toBe("new");
    expect(consoleIO.prompts).toHaveLength(3);
    expect(logger.messages).toContain("Invalid response. Enter y, n, or a.");
    expect(logger.messages).toContain(`Overwritten: ${secondPath}`);
    expect(logger.messages.at(-1)).toBe(
      "Migration completed. Created: 0, overwritten: 1, skipped: 1.",
    );
  });

  it("applies all without further prompts and silently ignores identical existing content", async () => {
    const directory = temporaryDirectory();
    const firstPath = join(directory, "first.txt");
    const secondPath = join(directory, "second.txt");
    const identicalPath = join(directory, "identical.txt");
    writeFileSync(firstPath, "old", "utf8");
    writeFileSync(secondPath, "old", "utf8");
    writeFileSync(identicalPath, "same", "utf8");
    const consoleIO = new TestConsole(["all"]);
    const logger = new CapturingLogger();

    await writeMigrationOutput([
      migratedFile(firstPath, "new"),
      migratedFile(secondPath, "new"),
      migratedFile(identicalPath, "same"),
    ], GenerationMode.Overwrite, consoleIO, logger);

    expect(consoleIO.prompts).toHaveLength(1);
    expect(readFileSync(firstPath, "utf8")).toBe("new");
    expect(readFileSync(secondPath, "utf8")).toBe("new");
    expect(logger.messages).toContain(`Overwritten: ${firstPath}`);
    expect(logger.messages).toContain(`Overwritten: ${secondPath}`);
    expect(logger.messages.at(-1)).toBe(
      "Migration completed. Created: 0, overwritten: 2, skipped: 0.",
    );
  });

  it("overwrites all files without prompting when prompts are accepted", async () => {
    const directory = temporaryDirectory();
    const firstPath = join(directory, "first.txt");
    const secondPath = join(directory, "second.txt");
    writeFileSync(firstPath, "old", "utf8");
    writeFileSync(secondPath, "old", "utf8");
    const consoleIO = new TestConsole();

    await writeMigrationOutput(
      [migratedFile(firstPath, "new"), migratedFile(secondPath, "new")],
      GenerationMode.Overwrite,
      consoleIO,
      new CapturingLogger(),
      undefined,
      true,
    );

    expect(consoleIO.prompts).toEqual([]);
    expect(readFileSync(firstPath, "utf8")).toBe("new");
    expect(readFileSync(secondPath, "utf8")).toBe("new");
  });

  it("counts newly created files in the overwrite summary", async () => {
    const filePath = join(temporaryDirectory(), "new.txt");
    const logger = new CapturingLogger();

    await writeMigrationOutput(
      [migratedFile(filePath, "content")],
      GenerationMode.Overwrite,
      new TestConsole(),
      logger,
    );

    expect(logger.messages).toEqual([
      `Created: ${filePath}`,
      "Migration completed. Created: 1, overwritten: 0, skipped: 0.",
    ]);
  });

  it("skips a dependent file when its prerequisite overwrite is declined", async () => {
    const directory = temporaryDirectory();
    const apaxPath = join(directory, "apax.yml");
    const makePath = join(directory, "make.yml");
    writeFileSync(apaxPath, "old", "utf8");
    const logger = new CapturingLogger();

    await writeMigrationOutput([
      migratedFile(apaxPath, "new"),
      { ...migratedFile(makePath, "generated"), skipWhenPathSkipped: apaxPath },
    ], GenerationMode.Overwrite, new TestConsole(["n"]), logger);

    expect(readFileSync(apaxPath, "utf8")).toBe("old");
    expect(existsSync(makePath)).toBe(false);
    expect(logger.messages).toContain(
      `Skipped creating file: ${makePath}`,
    );
    expect(logger.messages.at(-1)).toBe(
      "Migration completed. Created: 0, overwritten: 0, skipped: 2.",
    );
  });
});

describe("overwrite backups", () => {
  it("uses the nearest ancestor containing src and creates a normalized, filtered ZIP", async () => {
    const projectRoot = temporaryDirectory();
    const nestedProject = join(projectRoot, "projects", "child");
    mkdirSync(join(projectRoot, "src", "empty"), { recursive: true });
    mkdirSync(nestedProject, { recursive: true });
    mkdirSync(join(projectRoot, ".apax"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "main.st"), "source", "utf8");
    writeFileSync(join(projectRoot, ".apax", "secret.txt"), "secret", "utf8");
    writeFileSync(join(projectRoot, `${basename(projectRoot)}_20240101_010101.zip`), "old", "utf8");
    writeFileSync(join(projectRoot, "other.zip"), "keep", "utf8");
    symlinkSync(join(projectRoot, "src"), join(projectRoot, "linked-src"), "junction");
    const changedPath = join(projectRoot, "src", "main.st");
    const logger = new CapturingLogger();

    const result = await tryCreateBackup(
      nestedProject,
      [migratedFile(changedPath, "changed")],
      logger,
    );

    expect(result).toBe(true);
    expect(logger.messages[0]).toBe("Files that will be overwritten: 1");
    const backupFiles = readdirSync(projectRoot).filter((name) =>
      new RegExp(`^${escapeRegex(basename(projectRoot))}_\\d{8}_\\d{6}\\.zip$`, "i").test(name)
    );
    expect(backupFiles).toHaveLength(2);
    const createdBackup = backupFiles.find((name) => !name.includes("20240101_010101"));
    expect(createdBackup).toBeDefined();
    const entries = readZipEntryNames(join(projectRoot, createdBackup as string));
    expect(entries).toContain("src/");
    expect(entries).toContain("src/empty/");
    expect(entries).toContain("src/main.st");
    expect(entries).toContain("other.zip");
    expect(entries.every((name) => !name.includes("\\"))).toBe(true);
    expect(entries.some((name) => name.startsWith(".apax/"))).toBe(false);
    expect(entries.some((name) => name.endsWith("20240101_010101.zip"))).toBe(false);
    expect(entries.some((name) => name === createdBackup)).toBe(false);
    expect(entries.some((name) => name.startsWith("linked-src"))).toBe(false);
  });

  it("returns false and logs an error when backup creation fails", async () => {
    const missingDirectory = join(temporaryDirectory(), "missing");
    const logger = new CapturingLogger();

    const result = await tryCreateBackup(missingDirectory, [], logger);

    expect(result).toBe(false);
    expect(logger.entries.at(-1)?.level).toBe("error");
    expect(logger.messages.at(-1)).toContain("Failed to create overwrite backup archive.");
  });
});

class TestConsole implements ConsoleIO {
  readonly prompts: string[] = [];
  private readonly answers: string[];

  constructor(answers: string[] = []) {
    this.answers = [...answers];
  }

  get error(): string {
    return this.prompts.join("");
  }

  async readLine(): Promise<string | undefined> {
    return this.answers.shift();
  }

  writeError(message: string): void {
    this.prompts.push(message);
  }
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "migration-output-"));
  temporaryDirectories.push(directory);
  return directory;
}

function migratedFile(
  outputPath: string,
  content: string,
  hasChanges = true,
  reportWhenUnchanged = false,
): MigratedFile {
  return { sourcePath: outputPath, outputPath, content, hasChanges, reportWhenUnchanged };
}

function readZipEntryNames(zipPath: string): string[] {
  const data = readFileSync(zipPath);
  const names: string[] = [];
  for (let offset = 0; offset <= data.length - 46;) {
    if (data.readUInt32LE(offset) !== 0x02014b50) {
      offset += 1;
      continue;
    }

    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    names.push(data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}