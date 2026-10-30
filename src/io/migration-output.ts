import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import archiver from "archiver";
import { GenerationMode, type GenerationTarget } from "../domain/generation.js";
import type { Logger } from "../domain/logger.js";
import type { MigratedFile } from "../domain/migrated-file.js";
import type { ConsoleIO } from "./console-io.js";

interface WriteOverview {
  readonly changedFiles: string[];
  readonly createdFiles: string[];
  readonly overwrittenFiles: string[];
  readonly unchangedFiles: string[];
  readonly skippedFiles: string[];
}

interface ArchiveEntry {
  readonly path: string;
  readonly archivePath: string;
  readonly directory: boolean;
}

export async function tryPrepareTarget(
  projectDirectory: string,
  outputPath: string | undefined,
  mode: GenerationMode,
  consoleIO: ConsoleIO,
  logger: Logger,
  acceptAllPrompts = false,
): Promise<GenerationTarget | undefined> {
  if (mode === GenerationMode.Export) {
    return tryPrepareExportTarget(outputPath, consoleIO, logger, acceptAllPrompts);
  }

  logger.warn("Overwrite mode selected: files will be overwritten in the original project.");
  return { outputDirectory: projectDirectory };
}

export async function tryPrepareExportTarget(
  outputPath: string | undefined,
  consoleIO: ConsoleIO,
  logger: Logger,
  acceptAllPrompts = false,
): Promise<GenerationTarget | undefined> {
  const outputDirectory = isBlank(outputPath)
    ? join(process.cwd(), "migrated_project")
    : outputPath;

  if (!existsSync(outputDirectory)) {
    return { outputDirectory };
  } else if (readdirSync(outputDirectory).length > 0) {
    if (acceptAllPrompts) {
      return { outputDirectory, replaceOutputDirectory: true };
    }
    consoleIO.writeError(
      `The output directory '${outputDirectory}' is not empty. Delete its contents and continue? [y/N]\n`,
    );
    const response = await consoleIO.readLine();
    if (response?.toLowerCase() !== "y" && response?.toLowerCase() !== "yes") {
      logger.warn("Migration cancelled. The output directory was not changed.");
      return undefined;
    }

    return { outputDirectory, replaceOutputDirectory: true };
  }

  return { outputDirectory };
}

export function prepareOutputDirectory(target: GenerationTarget): void {
  if (target.replaceOutputDirectory === true) {
    rmSync(target.outputDirectory, { recursive: true, force: true });
  }
  mkdirSync(target.outputDirectory, { recursive: true });
}

export function tryValidateWorkspaceOutputPath(
  outputPath: string | undefined,
  logger: Logger,
): boolean {
  if (isBlank(outputPath)) {
    return true;
  }

  if (isAbsolute(outputPath)) {
    logger.error(`Workspace output must be a relative path inside each child project: ${outputPath}`);
    return false;
  }

  const projectDirectory = join(tmpdir(), "workspace-project");
  const resolvedOutputDirectory = resolve(projectDirectory, outputPath);
  if (
    pathsEqual(resolvedOutputDirectory, projectDirectory)
    || !isPathWithinDirectory(resolvedOutputDirectory, projectDirectory)
  ) {
    logger.error(`Workspace output must resolve to a folder inside each child project: ${outputPath}`);
    return false;
  }

  return true;
}

export async function tryCreateBackup(
  projectDirectory: string,
  migratedFiles: Iterable<MigratedFile>,
  logger: Logger,
): Promise<boolean> {
  const filesToMigrate = [...migratedFiles];
  const projectRootDirectory = findDirectoryContainingSrc(projectDirectory) ?? projectDirectory;
  const overwriteCount = filesToMigrate.filter((file) =>
    existsSync(file.outputPath) && readFileSync(file.outputPath, "utf8") !== file.content
  ).length;
  logger.info(`Files that will be overwritten: ${overwriteCount}`);

  const projectName = basename(projectRootDirectory);
  const backupPath = join(projectRootDirectory, `${projectName}_${formatTimestamp(new Date())}.zip`);

  try {
    const entries = collectArchiveEntries(projectRootDirectory, projectName, backupPath);
    await createArchive(backupPath, entries);
    logger.info(`Created overwrite backup archive: ${backupPath}`);
    return true;
  } catch {
    logger.error("Failed to create overwrite backup archive.");
    return false;
  }
}

export interface MigrationWriteResult {
  readonly skippedPaths: readonly string[];
  readonly writtenPaths: readonly string[];
}

export async function writeMigrationOutput(
  migratedFiles: Iterable<MigratedFile>,
  mode: GenerationMode,
  consoleIO: ConsoleIO,
  logger: Logger,
  projectName?: string,
  acceptAllPrompts = false,
): Promise<MigrationWriteResult> {
  const overview = createWriteOverview();
  const skippedPaths = new Set<string>();
  let applyOverwriteToAll = acceptAllPrompts;

  for (const migratedFile of migratedFiles) {
    if (
      migratedFile.skipWhenPathSkipped !== undefined
      && skippedPaths.has(migratedFile.skipWhenPathSkipped)
    ) {
      overview.skippedFiles.push(migratedFile.outputPath);
      skippedPaths.add(migratedFile.outputPath);
      logger.info(`Skipped creating file: ${migratedFile.outputPath}`);
      continue;
    }

    if (!migratedFile.hasChanges) {
      if (migratedFile.reportWhenUnchanged === true) {
        overview.unchangedFiles.push(migratedFile.outputPath);
      }
      continue;
    }

    const targetDirectory = dirname(migratedFile.outputPath);
    if (targetDirectory.length > 0) {
      mkdirSync(targetDirectory, { recursive: true });
    }

    const fileExists = existsSync(migratedFile.outputPath);
    if (mode === GenerationMode.Overwrite && fileExists) {
      if (readFileSync(migratedFile.outputPath, "utf8") === migratedFile.content) {
        continue;
      }

      if (!applyOverwriteToAll) {
        const confirmation = await confirmOverwrite(migratedFile.outputPath, consoleIO, logger);
        applyOverwriteToAll = confirmation.applyToAll;
        if (!confirmation.overwrite) {
          overview.skippedFiles.push(migratedFile.outputPath);
          skippedPaths.add(migratedFile.outputPath);
          continue;
        }
      }
    }

    writeFileSync(migratedFile.outputPath, migratedFile.content, "utf8");
    overview.changedFiles.push(migratedFile.outputPath);
    (fileExists ? overview.overwrittenFiles : overview.createdFiles).push(migratedFile.outputPath);
    if (mode === GenerationMode.Overwrite) {
      logger.info(`${fileExists ? "Overwritten" : "Created"}: ${migratedFile.outputPath}`);
    }
  }

  logOverview(overview, mode, logger, projectName);
  return {
    skippedPaths: overview.skippedFiles,
    writtenPaths: overview.changedFiles,
  };
}

async function confirmOverwrite(
  filePath: string,
  consoleIO: ConsoleIO,
  logger: Logger,
): Promise<{ readonly overwrite: boolean; readonly applyToAll: boolean }> {
  while (true) {
    consoleIO.writeError(
      `File will be overwritten: ${filePath}. Continue? [y]es/[n]o/yes to [a]ll:\n`,
    );
    const input = (await consoleIO.readLine())?.trim().toLowerCase();
    if (input === "y" || input === "yes") {
      return { overwrite: true, applyToAll: false };
    }
    if (input === "a" || input === "all") {
      return { overwrite: true, applyToAll: true };
    }
    if (input === undefined || input.length === 0 || input === "n" || input === "no") {
      logger.info(`Skipped overwriting file: ${filePath}`);
      return { overwrite: false, applyToAll: false };
    }
    logger.warn("Invalid response. Enter y, n, or a.");
  }
}

function logOverview(
  overview: WriteOverview,
  mode: GenerationMode,
  logger: Logger,
  projectName?: string,
): void {
  const exportFileCount = overview.changedFiles.length + overview.unchangedFiles.length;
  if (mode === GenerationMode.Export && exportFileCount > 0) {
    const projectLabel = projectName === undefined ? "" : ` for ${projectName}`;
    logger.info(`Migrated files overview${projectLabel} (${exportFileCount} files):`);
    for (const filePath of overview.createdFiles) logger.info(`Created: ${filePath}`);
    for (const filePath of overview.overwrittenFiles) logger.info(`Updated: ${filePath}`);
    for (const filePath of overview.unchangedFiles) logger.info(`Unchanged: ${filePath}`);
  }

  if (mode === GenerationMode.Overwrite) {
    logger.info(
      `Migration completed. Created: ${overview.createdFiles.length}, overwritten: ${overview.overwrittenFiles.length}, skipped: ${overview.skippedFiles.length}.`,
    );
  }
}

function collectArchiveEntries(
  rootDirectory: string,
  projectName: string,
  backupPath: string,
): ArchiveEntry[] {
  const directories: ArchiveEntry[] = [];
  const files: ArchiveEntry[] = [];

  function visit(directoryPath: string): void {
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      const entryPath = join(directoryPath, entry.name);
      const archivePath = normalizeArchivePath(relative(rootDirectory, entryPath));
      if (entry.isDirectory()) {
        if (pathsEqual(entryPath, join(rootDirectory, ".apax"))) continue;
        directories.push({ path: entryPath, archivePath: `${archivePath}/`, directory: true });
        visit(entryPath);
      } else if (
        entry.isFile()
        &&
        !pathsEqual(entryPath, backupPath)
        && !isBackupArchive(entryPath, projectName)
      ) {
        files.push({ path: entryPath, archivePath, directory: false });
      }
    }
  }

  visit(rootDirectory);
  const compare = (left: ArchiveEntry, right: ArchiveEntry): number =>
    left.archivePath.localeCompare(right.archivePath, undefined, { sensitivity: "base" });
  return [...directories.sort(compare), ...files.sort(compare)];
}

function createArchive(backupPath: string, entries: readonly ArchiveEntry[]): Promise<void> {
  return new Promise((resolveArchive, rejectArchive) => {
    const output = createWriteStream(backupPath, { flags: "wx" });
    const archive = archiver("zip", { zlib: { level: 9 } });
    let settled = false;
    const reject = (error: Error): void => {
      if (!settled) {
        settled = true;
        rejectArchive(error);
      }
    };

    output.on("close", () => {
      if (!settled) {
        settled = true;
        resolveArchive();
      }
    });
    output.on("error", reject);
    archive.on("error", reject);
    archive.on("warning", reject);
    archive.pipe(output);

    for (const entry of entries) {
      if (entry.directory) {
        archive.append(Buffer.alloc(0), { name: entry.archivePath });
      } else {
        const input = createReadStream(entry.path);
        input.on("error", reject);
        archive.append(input, { name: entry.archivePath });
      }
    }
    void archive.finalize().catch(reject);
  });
}

function findDirectoryContainingSrc(startDirectory: string): string | undefined {
  let directory = resolve(startDirectory);
  while (true) {
    if (existsSync(join(directory, "src"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function isPathWithinDirectory(path: string, directory: string): boolean {
  const relativePath = relative(directory, path);
  return !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function isBackupArchive(path: string, projectName: string): boolean {
  const fileName = basename(path).toLowerCase();
  return fileName.startsWith(`${projectName.toLowerCase()}_`) && fileName.endsWith(".zip");
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function normalizeArchivePath(path: string): string {
  return path.split(sep).join("/");
}

function formatTimestamp(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function createWriteOverview(): WriteOverview {
  return {
    changedFiles: [],
    createdFiles: [],
    overwrittenFiles: [],
    unchangedFiles: [],
    skippedFiles: [],
  };
}

function isBlank(value: string | undefined): value is undefined {
  return value === undefined || value.trim().length === 0;
}
