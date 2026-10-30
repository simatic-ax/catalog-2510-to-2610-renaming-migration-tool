import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { getValue } from "../mappings/case-insensitive-map.js";
import { namespaceMappings } from "../mappings/namespaces.js";

export interface MigratedStructuredTextFile {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly content: string;
  readonly hasChanges: boolean;
}

const namespacePattern = Object.keys(namespaceMappings)
  .sort((left, right) => right.length - left.length)
  .map(escapeRegularExpression)
  .join("|");

const usingPattern = new RegExp(
  String.raw`(?<block>\/\*[\s\S]*?(?:\*\/|(?![\s\S])))|(?<line>\/\/[^\r\n]*)|^(?<indent>[ \t]*)(?<usingkw>using\s+)(?<namespace>[a-zA-Z_][a-zA-Z0-9_.]*)(?<semi>\s*;)(?<tail>[^\r\n]*)`,
  "gim",
);

const fullyQualifiedPattern = new RegExp(
  String.raw`(?<block>\/\*[\s\S]*?(?:\*\/|(?![\s\S])))|(?<line>\/\/[^\r\n]*)|(?<string>'(?:''|[^'\r\n])*'|"(?:""|[^"\r\n])*")|(?<using>^[ \t]*using\b[^\r\n]*)|(?<![a-zA-Z0-9_])(?<namespace>${namespacePattern})(?=\.|[^a-zA-Z0-9_]|$)`,
  "gim",
);

export function migrateStructuredText(
  sourceDirectory: string,
  outputDirectory: string,
): readonly MigratedStructuredTextFile[] {
  const sourceRootName = basename(sourceDirectory);
  const generatedDirectory = join(sourceDirectory, ".gen");

  return findStructuredTextFiles(sourceDirectory)
    .filter(
      (filePath) =>
        sourceRootName.toLocaleLowerCase("en-US") !== "src" ||
        !isPathWithinDirectory(filePath, generatedDirectory),
    )
    .map((filePath) => {
      const content = readFileSync(filePath, "utf8");
      const migratedContent = migrateFullyQualifiedNamespaces(migrateUsingNamespaces(content));
      return {
        sourcePath: filePath,
        outputPath: join(
          outputDirectory,
          sourceRootName,
          relative(sourceDirectory, filePath),
        ),
        content: migratedContent,
        hasChanges: content !== migratedContent,
      };
    });
}

function findStructuredTextFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.toLocaleLowerCase("en-US") === ".apax") continue;
      files.push(...findStructuredTextFiles(entryPath));
    } else if (entry.isFile() && extname(entry.name).toLocaleLowerCase("en-US") === ".st") {
      files.push(entryPath);
    }
  }
  return files;
}

function migrateUsingNamespaces(content: string): string {
  return content.replace(usingPattern, (match: string, ...arguments_: unknown[]) => {
    const groups = readReplacementGroups(arguments_);
    const namespace = groups["namespace"];
    if (namespace === undefined) {
      return match;
    }

    const migratedNamespace = getValue(namespaceMappings, namespace);
    return migratedNamespace === undefined
      ? match
      : `${groups["indent"] ?? ""}USING ${migratedNamespace}${groups["semi"] ?? ""}${groups["tail"] ?? ""}`;
  });
}

function migrateFullyQualifiedNamespaces(content: string): string {
  return content.replace(fullyQualifiedPattern, (match: string, ...arguments_: unknown[]) => {
    const namespace = readReplacementGroups(arguments_)["namespace"];
    return namespace === undefined ? match : (getValue(namespaceMappings, namespace) ?? match);
  });
}

function readReplacementGroups(arguments_: readonly unknown[]): Record<string, string | undefined> {
  const groups = arguments_.at(-1);
  return typeof groups === "object" && groups !== null
    ? (groups as Record<string, string | undefined>)
    : {};
}

function isPathWithinDirectory(path: string, directory: string): boolean {
  const relativePath = relative(directory, path);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}