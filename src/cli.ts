#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Builtins, Cli, Command, Option, type BaseContext } from "clipanion";
import {
  executeMigrateCommand,
  getErrorMessage,
  getResourceBusyMessage,
  isAccessError,
  isIoError,
  isResourceBusyError,
} from "./commands/migrate-command.js";
import { CliExitCode } from "./domain/cli-exit-codes.js";
import type { Logger } from "./domain/logger.js";
import type { ConsoleIO } from "./io/console-io.js";

interface MigrationCliContext extends BaseContext {
  readonly currentDirectory: () => string;
  readonly consoleIO: ConsoleIO;
  readonly logger: Logger;
}

export interface CliStreams {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

class MigrateCliCommand extends Command<MigrationCliContext> {
  static override paths = [["migrate"]];
  static override usage = Command.Usage({
    description: "Migrate a catalog 2510 app, library, or workspace to catalog 2610.",
  });

  outputPath = Option.String("-o,--output", {
    description: "The output path for the migrated project.",
  });

  mode = Option.String("-m,--mode", {
    description: "Generation mode: Export(default), OverWrite.",
  });

  skipBackup = Option.Boolean("-s,--skipsave", false, {
    description: "Skip creating a project backup zip in OverWrite mode.",
  });

  acceptAllPrompts = Option.Boolean("--accept-all-prompts", false, {
    description: "Accept all confirmation prompts and select all workspace projects.",
  });

  catalog = Option.String("--catalog", {
    description: "Target catalog: latest, 2610.x.y, or @domain/catalog@2610.x.y.",
  });

  exact = Option.Boolean("--exact", false, {
    description: "Pin the target catalog version exactly.",
  });

  tilde = Option.Boolean("--tilde", false, {
    description: "Use tilde compatibility for the target catalog.",
  });

  caret = Option.Boolean("--caret", false, {
    description: "Use caret compatibility for the target catalog.",
  });

  showVersion = Option.Boolean("-v,--version", false, {
    description: "Print the package version.",
  });

  async execute(): Promise<number> {
    try {
      if (this.showVersion) {
        this.context.stdout.write(`${readPackageVersion()}\n`);
        return CliExitCode.Success;
      }

      return await executeMigrateCommand(
        {
          acceptAllPrompts: this.acceptAllPrompts,
          ...(this.outputPath === undefined ? {} : { outputPath: this.outputPath }),
          ...(this.mode === undefined ? {} : { mode: this.mode }),
          ...(this.catalog === undefined ? {} : { catalog: this.catalog }),
          caret: this.caret,
          exact: this.exact,
          skipBackup: this.skipBackup,
          tilde: this.tilde,
        },
        {
          currentDirectory: this.context.currentDirectory,
          consoleIO: this.context.consoleIO,
          logger: this.context.logger,
        },
      );
    } catch (error) {
      const message = getErrorMessage(error);
      if (isAccessError(error)) {
        this.context.logger.error(`Access denied: ${message}`);
        return CliExitCode.Io;
      }
      if (isIoError(error)) {
        this.context.logger.error(
          isResourceBusyError(error)
            ? getResourceBusyMessage(error)
            : `I/O operation failed: ${message}`,
        );
        return CliExitCode.Io;
      }

      this.context.logger.error(`Migration failed unexpectedly: ${message}`);
      return CliExitCode.Migration;
    }
  }
}

export async function runCli(
  arguments_: readonly string[],
  streams: CliStreams = process,
  currentDirectory: () => string = () => process.cwd(),
): Promise<number> {
  const logger = createConsoleLogger(streams.stderr);
  const consoleIO = createConsoleIO(streams.stdin, streams.stderr);
  const context: MigrationCliContext = {
    env: process.env,
    stdin: streams.stdin,
    stdout: streams.stdout,
    stderr: streams.stderr,
    colorDepth: getColorDepth(streams.stderr),
    currentDirectory,
    consoleIO,
    logger,
  };
  const cli = Cli.from<MigrationCliContext>(
    [MigrateCliCommand, Builtins.HelpCommand, Builtins.VersionCommand],
    {
      binaryLabel: "MigrateTool",
      binaryName: "migrate-tool",
      binaryVersion: readPackageVersion(),
      enableColors: false,
    },
  );

  const input = arguments_.length === 0 ? ["--help"] : [...arguments_];
  try {
    if (input.includes("-h") || input.includes("--help")) {
      const command = input[0] === "migrate" ? MigrateCliCommand : null;
      const usage = cli.usage(command, { detailed: command !== null })
        .replace("-o,--output #0", "-o,--output <path>")
        .replace("-m,--mode #0", "-m,--mode <mode>")
        .replace("--catalog #0", "--catalog <catalog>");
      streams.stdout.write(usage);
      return CliExitCode.Success;
    }

    const command = cli.process(input, context);
    return await cli.run(command, context);
  } catch (error) {
    logger.error(`${getErrorMessage(error)} Use --help to see available options and commands.`);
    return CliExitCode.Usage;
  } finally {
    consoleIO.close?.();
  }
}

function createConsoleIO(stdin: Readable, stderr: Writable): ConsoleIO {
  const interface_ = createInterface({ input: stdin, output: stderr });
  return {
    async readLine(): Promise<string | undefined> {
      try {
        return await interface_.question("");
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return undefined;
        throw error;
      }
    },
    writeError(message: string): void {
      stderr.write(message);
    },
    close(): void {
      interface_.close();
    },
  };
}

function createConsoleLogger(stderr: Writable): Logger {
  const write = (level: "info" | "warn" | "error", message: string): void => {
    const color = level === "info" ? "\u001b[32m" : level === "warn" ? "\u001b[33m" : "\u001b[31m";
    stderr.write(
      `MigrationTool: ${formatTimestamp(new Date())} [${color}${level}\u001b[0m]${message}\n`,
    );
  };
  return {
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
  };
}

function formatTimestamp(date: Date): string {
  const pad = (value: number, length = 2): string => value.toString().padStart(length, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`,
  ].join(" ");
}

function readPackageVersion(): string {
  for (const relativePath of ["./package.json", "../package.json"]) {
    try {
      const packagePath = fileURLToPath(new URL(relativePath, import.meta.url));
      const metadata = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
      if (typeof metadata.version === "string") return metadata.version;
    } catch {
      // Try the source-tree or packaged location next.
    }
  }
  return "0.0.0";
}

function getColorDepth(stream: Writable): number {
  return "getColorDepth" in stream && typeof stream.getColorDepth === "function"
    ? stream.getColorDepth()
    : 1;
}

if (
  process.argv[1] !== undefined
  && basename(fileURLToPath(import.meta.url)) === "cli.js"
  && fileURLToPath(import.meta.url) === process.argv[1]
) {
  process.exitCode = await runCli(process.argv.slice(2));
}