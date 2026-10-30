import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ApaxConfig } from "../domain/apax-config.js";
import { type CatalogOptions, defaultCatalogOptions } from "../domain/catalog-options.js";
import { CliExitCode } from "../domain/cli-exit-codes.js";
import { GenerationMode, type GenerationTarget } from "../domain/generation.js";
import type { Logger } from "../domain/logger.js";
import type { MigratedFile } from "../domain/migrated-file.js";
import { type ApaxCommandRunner, runApaxCommand } from "../io/apax-command-runner.js";
import type { ConsoleIO } from "../io/console-io.js";
import { writeApax } from "../io/apax-writer.js";
import { writeMake } from "../io/make-writer.js";
import {
  prepareOutputDirectory,
  tryCreateBackup,
  writeMigrationOutput,
} from "../io/migration-output.js";
import { migrateApax } from "./apax-migrator.js";
import { acquireCatalog, type CatalogAcquirer } from "./catalog-resolver.js";
import { applyCatalogVersions, resolvePackageVersions } from "./package-version-resolver.js";
import { migrateStructuredText } from "./structured-text-migrator.js";

interface PreparedProjectMigration {
  readonly acceptAllPrompts: boolean;
  readonly projectDirectory: string;
  readonly target: GenerationTarget;
  readonly mode: GenerationMode;
  readonly skipBackup: boolean;
  readonly consoleIO: ConsoleIO;
  readonly logger: Logger;
  readonly migratedFiles: readonly MigratedFile[];
}

export interface ProjectMigrationTransaction {
  readonly preparedProjects: PreparedProjectMigration[];
}

export async function migrateProject(
  projectDirectory: string,
  target: GenerationTarget,
  mode: GenerationMode,
  skipBackup: boolean,
  consoleIO: ConsoleIO,
  logger: Logger,
  apax: ApaxConfig,
  catalogOptions: CatalogOptions = defaultCatalogOptions,
  runApax: ApaxCommandRunner = runApaxCommand,
  transaction?: ProjectMigrationTransaction,
  catalogsRoot?: string,
  acquireCatalog_: CatalogAcquirer = acquireCatalog,
  acceptAllPrompts = false,
): Promise<CliExitCode> {
  const sourceDirectories = ["src", "test"]
    .map((name) => join(projectDirectory, name))
    .filter((directory) => existsSync(directory) && statSync(directory).isDirectory());
  if (sourceDirectories.length === 0) {
    logger.error(`Neither src nor test folder was found in project: ${projectDirectory}`);
    return CliExitCode.Validation;
  }

  const resolvedCatalog = await acquireCatalog_(
    apax.original,
    catalogOptions,
    runApax,
    logger,
    catalogsRoot,
  );
  if (resolvedCatalog === undefined) {
    return CliExitCode.Migration;
  }

  const apaxMigration = migrateApax(
    apax,
    logger,
    resolvedCatalog.name,
    formatCatalogVersion(resolvedCatalog.version, catalogOptions.compatibility),
  );
  if (apaxMigration === undefined) {
    return CliExitCode.Migration;
  }

  const nonCatalogPackages = applyCatalogVersions(
    apax,
    apaxMigration.mappedPackages,
    resolvedCatalog.dependencies,
  );
  if (!await resolvePackageVersions(
    apax,
    nonCatalogPackages,
    projectDirectory,
    runApax,
    logger,
  )) {
    return CliExitCode.Migration;
  }

  const alignedApaxContent = writeApax(apax);
  const migratedFiles: MigratedFile[] = sourceDirectories.flatMap((directory) =>
    migrateStructuredText(directory, target.outputDirectory)
  );
  addApaxFile(migratedFiles, apax, target.outputDirectory, alignedApaxContent);
  addMakeFile(migratedFiles, apax, projectDirectory, target, mode);

  const preparedMigration: PreparedProjectMigration = {
    acceptAllPrompts,
    projectDirectory,
    target,
    mode,
    skipBackup,
    consoleIO,
    logger,
    migratedFiles,
  };
  if (transaction !== undefined) {
    transaction.preparedProjects.push(preparedMigration);
    return CliExitCode.Success;
  }

  return commitProjectMigration(preparedMigration);
}

function formatCatalogVersion(
  version: string,
  compatibility: CatalogOptions["compatibility"],
): string {
  if (compatibility === "exact") return version;
  return `${compatibility === "tilde" ? "~" : "^"}${version}`;
}

export async function commitProjectMigration(
  migration: PreparedProjectMigration,
): Promise<CliExitCode> {
  const {
    acceptAllPrompts,
    projectDirectory,
    target,
    mode,
    skipBackup,
    consoleIO,
    logger,
    migratedFiles,
  } = migration;
  if (
    mode === GenerationMode.Overwrite
    && !skipBackup
    && !await tryCreateBackup(projectDirectory, migratedFiles, logger)
  ) {
    return CliExitCode.Io;
  }

  if (mode === GenerationMode.Export) {
    prepareOutputDirectory(target);
  }
  await writeMigrationOutput(
    migratedFiles,
    mode,
    consoleIO,
    logger,
    basename(projectDirectory),
    acceptAllPrompts,
  );
  return CliExitCode.Success;
}

function addApaxFile(
  files: MigratedFile[],
  config: ApaxConfig,
  outputDirectory: string,
  content: string,
): void {
  files.push({
    sourcePath: config.sourcePath,
    outputPath: join(outputDirectory, "apax.yml"),
    content,
    hasChanges: config.originalContent !== content,
  });
}

function addMakeFile(
  files: MigratedFile[],
  config: ApaxConfig,
  projectDirectory: string,
  target: GenerationTarget,
  mode: GenerationMode,
): void {
  const sourcePath = join(projectDirectory, "make.yml");
  const outputPath = mode === GenerationMode.Overwrite
    ? sourcePath
    : join(target.outputDirectory, "make.yml");
  const content = writeMake(config);
  const originalContent = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";

  files.push({
    sourcePath,
    outputPath,
    content,
    hasChanges: target.replaceOutputDirectory === true || originalContent !== content,
    reportWhenUnchanged: mode === GenerationMode.Export,
    ...(mode === GenerationMode.Overwrite
      ? { skipWhenPathSkipped: join(target.outputDirectory, "apax.yml") }
      : {}),
  });
}