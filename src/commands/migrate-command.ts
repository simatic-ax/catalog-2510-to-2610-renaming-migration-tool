import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ApaxConfig } from "../domain/apax-config.js";
import {
  type CatalogCompatibility,
  type CatalogOptions,
  defaultCatalogOptions,
  parseCatalogReference,
} from "../domain/catalog-options.js";
import { CliExitCode } from "../domain/cli-exit-codes.js";
import { GenerationMode, type GenerationTarget } from "../domain/generation.js";
import type { Logger } from "../domain/logger.js";
import { type ApaxCommandRunner, runApaxCommand } from "../io/apax-command-runner.js";
import type { ConsoleIO } from "../io/console-io.js";
import { tryParseApax } from "../io/apax-parser.js";
import {
  tryPrepareExportTarget,
  tryPrepareTarget,
  tryValidateWorkspaceOutputPath,
} from "../io/migration-output.js";
import {
  commitProjectMigration,
  migrateProject,
  type ProjectMigrationTransaction,
} from "../migration/project-migrator.js";
import { acquireCatalog, type CatalogAcquirer } from "../migration/catalog-resolver.js";
import { getValue } from "../mappings/case-insensitive-map.js";

export interface MigrateCommandOptions {
  readonly acceptAllPrompts?: boolean;
  readonly caret?: boolean;
  readonly catalog?: string;
  readonly exact?: boolean;
  readonly outputPath?: string;
  readonly mode?: string;
  readonly skipBackup?: boolean;
  readonly tilde?: boolean;
}

export interface MigrateCommandDependencies {
  readonly currentDirectory: () => string;
  readonly consoleIO: ConsoleIO;
  readonly logger: Logger;
  readonly parseApax: (filePath: string, logger: Logger) => ApaxConfig | undefined;
  readonly prepareTarget: typeof tryPrepareTarget;
  readonly prepareExportTarget: typeof tryPrepareExportTarget;
  readonly validateWorkspaceOutputPath: typeof tryValidateWorkspaceOutputPath;
  readonly migrateProject: typeof migrateProject;
  readonly commitProjectMigration: typeof commitProjectMigration;
  readonly acquireCatalog: CatalogAcquirer;
  readonly runApax: ApaxCommandRunner;
  readonly discoverProjects: (workspaceDirectory: string) => string[];
}

interface WorkspaceProject {
  readonly directory: string;
  readonly config: ApaxConfig;
}

interface ParsedCatalogOptions extends Omit<CatalogOptions, "compatibility"> {
  readonly compatibility?: CatalogCompatibility;
}

export async function executeMigrateCommand(
  options: MigrateCommandOptions,
  dependencies: Partial<MigrateCommandDependencies> & Pick<MigrateCommandDependencies, "consoleIO" | "logger">,
): Promise<CliExitCode> {
  const runtime: MigrateCommandDependencies = {
    currentDirectory: () => process.cwd(),
    parseApax: tryParseApax,
    prepareTarget: tryPrepareTarget,
    prepareExportTarget: tryPrepareExportTarget,
    validateWorkspaceOutputPath: tryValidateWorkspaceOutputPath,
    migrateProject,
    commitProjectMigration,
    acquireCatalog,
    runApax: runApaxCommand,
    discoverProjects,
    ...dependencies,
  };
  const mode = parseMode(options.mode, runtime.logger);
  if (mode === undefined) return CliExitCode.Usage;
  const catalogOptions = parseCatalogOptions(options, runtime.logger);
  if (catalogOptions === undefined) return CliExitCode.Usage;

  const currentDirectory = runtime.currentDirectory();
  const apaxPath = join(currentDirectory, "apax.yml");
  const rootConfig = runtime.parseApax(apaxPath, runtime.logger);
  if (rootConfig === undefined) return CliExitCode.Validation;

  if (equalsIgnoreCase(rootConfig.original.projectType, "workspace")) {
    return migrateWorkspace(currentDirectory, options, mode, catalogOptions, runtime);
  }

  if (!isMigratableProject(rootConfig.original.projectType)) {
    runtime.logger.error(
      `Unsupported project type '${rootConfig.original.projectType}' in ${apaxPath}. Expected app, lib, or workspace.`,
    );
    return CliExitCode.Validation;
  }

  const targetOutputPath = mode === GenerationMode.Export
    ? resolveExportPath(currentDirectory, options.outputPath)
    : options.outputPath;
  const target = await runtime.prepareTarget(
    currentDirectory,
    targetOutputPath,
    mode,
    runtime.consoleIO,
    runtime.logger,
    options.acceptAllPrompts ?? false,
  );
  if (target === undefined) return CliExitCode.Validation;

  return runtime.migrateProject(
    currentDirectory,
    target,
    mode,
    options.skipBackup ?? false,
    runtime.consoleIO,
    runtime.logger,
    rootConfig,
    resolveCatalogOptions(catalogOptions, rootConfig),
    runtime.runApax,
    undefined,
    undefined,
    runtime.acquireCatalog,
    options.acceptAllPrompts ?? false,
  );
}

async function migrateWorkspace(
  workspaceDirectory: string,
  options: MigrateCommandOptions,
  mode: GenerationMode,
  parsedCatalogOptions: ParsedCatalogOptions,
  runtime: MigrateCommandDependencies,
): Promise<CliExitCode> {
  if (
    mode === GenerationMode.Export
    && !runtime.validateWorkspaceOutputPath(options.outputPath, runtime.logger)
  ) {
    return CliExitCode.Validation;
  }

  if (mode === GenerationMode.Overwrite) {
    runtime.logger.warn("Overwrite mode selected: files will be overwritten in the original project.");
  }

  const discoveredProjects = discoverMigratableProjects(workspaceDirectory, runtime);
  if (discoveredProjects.length === 0) {
    runtime.logger.error(
      `No direct app or lib projects were found in workspace: ${workspaceDirectory}`,
    );
    return CliExitCode.Validation;
  }
  const projects = await selectWorkspaceProjects(
    workspaceDirectory,
    discoveredProjects,
    runtime.consoleIO,
    runtime.logger,
    options.acceptAllPrompts ?? false,
  );
  if (projects === undefined) return CliExitCode.Validation;
  const catalogOptions = resolveCatalogOptions(parsedCatalogOptions, projects[0]!.config);

  const resolvedCatalog = await runtime.acquireCatalog(
    projects[0]!.config.original,
    catalogOptions,
    runtime.runApax,
    runtime.logger,
  );
  if (resolvedCatalog === undefined) {
    runtime.logger.error("Workspace migration was not migrated because catalog acquisition failed.");
    return CliExitCode.Migration;
  }
  const useResolvedCatalog: CatalogAcquirer = async () => resolvedCatalog;

  let succeededCount = 0;
  let exitCode = CliExitCode.Success;
  const failedProjects: string[] = [];
  const transaction: ProjectMigrationTransaction = { preparedProjects: [] };
  for (const project of projects) {
    const projectExitCode = await migrateWorkspaceProject(
      project.directory,
      options,
      mode,
      catalogOptions,
      runtime,
      project.config,
      transaction,
      useResolvedCatalog,
    );
    if (projectExitCode === CliExitCode.Success) {
      succeededCount++;
    } else {
      failedProjects.push(project.directory);
      exitCode = Math.max(exitCode, projectExitCode);
      break;
    }
  }

  if (exitCode === CliExitCode.Success) {
    for (const preparedProject of transaction.preparedProjects) {
      const commitExitCode = await runtime.commitProjectMigration(preparedProject);
      if (commitExitCode !== CliExitCode.Success) {
        exitCode = Math.max(exitCode, commitExitCode);
      }
    }
  } else {
    runtime.logger.error("Workspace migration was not written because at least one project failed.");
  }

  runtime.logger.info(
    `Workspace migration completed. Succeeded: ${succeededCount}, failed: ${failedProjects.length}.`,
  );
  for (const failedProject of failedProjects) {
    runtime.logger.error(`Failed project: ${failedProject}`);
  }
  return exitCode;
}

async function migrateWorkspaceProject(
  projectDirectory: string,
  options: MigrateCommandOptions,
  mode: GenerationMode,
  catalogOptions: CatalogOptions,
  runtime: MigrateCommandDependencies,
  discoveredConfig?: ApaxConfig,
  transaction?: ProjectMigrationTransaction,
  acquireCatalog_: CatalogAcquirer = runtime.acquireCatalog,
): Promise<CliExitCode> {
  runtime.logger.info(`Starting to migrate: ${basename(projectDirectory)}`);

  try {
    const apaxPath = join(projectDirectory, "apax.yml");
    const config = discoveredConfig ?? runtime.parseApax(apaxPath, runtime.logger);
    if (config === undefined) return CliExitCode.Validation;

    if (!isMigratableProject(config.original.projectType)) {
      runtime.logger.error(
        `Unsupported workspace child project type '${config.original.projectType}' in ${apaxPath}. Expected app or lib.`,
      );
      return CliExitCode.Validation;
    }

    let target: GenerationTarget = { outputDirectory: projectDirectory };
    if (mode === GenerationMode.Export) {
      const childOutputDirectory = resolve(
        projectDirectory,
        options.outputPath ?? "migrated_project",
      );
      const exportTarget = await runtime.prepareExportTarget(
        childOutputDirectory,
        runtime.consoleIO,
        runtime.logger,
        options.acceptAllPrompts ?? false,
      );
      if (exportTarget === undefined) return CliExitCode.Validation;
      target = exportTarget;
    }

    return await runtime.migrateProject(
      projectDirectory,
      target,
      mode,
      options.skipBackup ?? false,
      runtime.consoleIO,
      runtime.logger,
      config,
      catalogOptions,
      runtime.runApax,
      transaction,
      undefined,
      acquireCatalog_,
      options.acceptAllPrompts ?? false,
    );
  } catch (error) {
    const message = getErrorMessage(error);
    if (isAccessError(error)) {
      runtime.logger.error(`Access denied while migrating ${projectDirectory}: ${message}`);
      return CliExitCode.Io;
    }
    if (isIoError(error)) {
      if (isResourceBusyError(error)) {
        runtime.logger.error(getResourceBusyMessage(error));
        return CliExitCode.Io;
      }
      runtime.logger.error(
        `I/O operation failed while migrating ${projectDirectory}: ${message}`,
      );
      return CliExitCode.Io;
    }

    runtime.logger.error(
      `Failed to migrate workspace child project ${projectDirectory}: ${message}`,
    );
    return CliExitCode.Migration;
  }
}

function parseMode(value: string | undefined, logger: Logger): GenerationMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0 || normalized === "export") {
    return GenerationMode.Export;
  }
  if (normalized === "overwrite") return GenerationMode.Overwrite;

  logger.error(`Invalid generation mode: ${value}. Allowed values: Export, OverWrite.`);
  return undefined;
}

function isMigratableProject(projectType: string): boolean {
  return equalsIgnoreCase(projectType, "app") || equalsIgnoreCase(projectType, "lib");
}

function discoverProjects(workspaceDirectory: string): string[] {
  const ignoredDirectories = new Set([".apax", ".vscode", ".ax"]);
  return readdirSync(workspaceDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !ignoredDirectories.has(entry.name.toLowerCase()))
    .map((entry) => join(workspaceDirectory, entry.name))
    .filter((directory) => existsSync(join(directory, "apax.yml")))
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

function equalsIgnoreCase(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "base" }) === 0;
}

function resolveExportPath(currentDirectory: string, outputPath: string | undefined): string {
  return resolve(
    currentDirectory,
    outputPath === undefined || outputPath.trim().length === 0
      ? "migrated_project"
      : outputPath,
  );
}

export function isAccessError(error: unknown): boolean {
  return isErrnoException(error) && (error.code === "EACCES" || error.code === "EPERM");
}

export function isIoError(error: unknown): boolean {
  return isErrnoException(error) && error.code !== undefined;
}

export function isResourceBusyError(error: unknown): error is NodeJS.ErrnoException {
  return isErrnoException(error) && error.code === "EBUSY";
}

export function getResourceBusyMessage(error: NodeJS.ErrnoException): string {
  const path = typeof error.path === "string" && error.path.length > 0
    ? ` at '${error.path}'`
    : "";
  return `Resource busy or locked: cannot update output${path}. Close any application using this path and try again.`;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function discoverMigratableProjects(
  workspaceDirectory: string,
  runtime: MigrateCommandDependencies,
): WorkspaceProject[] {
  const projects: WorkspaceProject[] = [];
  for (const directory of runtime.discoverProjects(workspaceDirectory)) {
    const apaxPath = join(directory, "apax.yml");
    const config = runtime.parseApax(apaxPath, runtime.logger);
    if (config === undefined) continue;
    if (!isMigratableProject(config.original.projectType)) {
      runtime.logger.error(
        `Unsupported workspace child project type '${config.original.projectType}' in ${apaxPath}. Expected app or lib. Skipping project.`,
      );
      continue;
    }
    projects.push({ directory, config });
  }
  return projects;
}

async function selectWorkspaceProjects(
  workspaceDirectory: string,
  projects: readonly WorkspaceProject[],
  consoleIO: ConsoleIO,
  logger: Logger,
  acceptAllPrompts = false,
): Promise<readonly WorkspaceProject[] | undefined> {
  if (projects.length === 1 || acceptAllPrompts) return projects;

  const projectList = [
    `Workspace projects: ${workspaceDirectory}`,
    ...projects.map((project, index) => `  ${index + 1}. ${basename(project.directory)}`),
  ];
  consoleIO.writeError(`${projectList.join("\n")}\n`);

  while (true) {
    consoleIO.writeError("Select projects: Enter project numbers separated by commas, or [a]ll projects:\n");
    const input = (await consoleIO.readLine())?.trim().toLowerCase();
    if (input === undefined) {
      logger.warn("Workspace project selection was cancelled.");
      return undefined;
    }
    if (input === "a" || input === "all") {
      return projects;
    }

    const indexes = [...new Set(input.split(",").map((value) => Number(value.trim()) - 1))];
    if (
      indexes.length > 0
      && indexes.every((index) => Number.isInteger(index) && index >= 0 && index < projects.length)
    ) {
      return indexes.map((index) => projects[index]!);
    }
    logger.warn("Invalid selection. Enter project numbers separated by commas, or a for all projects.");
  }
}

function parseCatalogOptions(
  options: MigrateCommandOptions,
  logger: Logger,
): ParsedCatalogOptions | undefined {
  const selected = ([
    ["exact", options.exact],
    ["tilde", options.tilde],
    ["caret", options.caret],
  ] as const).filter(([, enabled]) => enabled === true).map(([name]) => name);
  if (selected.length > 1) {
    logger.error("Only one catalog compatibility option may be used: --exact, --tilde, or --caret.");
    return undefined;
  }

  const catalogValue = options.catalog?.trim() || defaultCatalogOptions.version;
  const catalog = parseCatalogReference(catalogValue);
  if (catalog === undefined) {
    logger.error(
      `Invalid catalog: ${catalogValue}. Use latest, 2610.x.y, or @domain/catalog@2610.x.y.`,
    );
    return undefined;
  }
  return { ...(selected[0] === undefined ? {} : { compatibility: selected[0] }), ...catalog };
}

function resolveCatalogOptions(
  options: ParsedCatalogOptions,
  config: ApaxConfig,
): CatalogOptions {
  if (options.compatibility !== undefined) {
    return { ...options, compatibility: options.compatibility };
  }

  const sourceVersion = getValue(config.original.catalogs, "@ax/simatic-ax")?.trim() ?? "";
  const compatibility: CatalogCompatibility = sourceVersion.startsWith("~")
    ? "tilde"
    : sourceVersion.startsWith("^")
    ? "caret"
    : "exact";
  return { ...options, compatibility };
}