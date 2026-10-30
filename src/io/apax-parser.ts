import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  createApaxConfig,
  createApaxValues,
  type ApaxConfig,
  type StringMapping,
} from "../domain/apax-config.js";
import type { Logger } from "../domain/logger.js";
import { getValue } from "../mappings/case-insensitive-map.js";
import { getCompilerOptionInlineComment } from "../migration/compiler-option-resolver.js";

export function tryParseApax(filePath: string, logger: Logger): ApaxConfig | undefined {
  if (!existsSync(filePath)) {
    logger.error(`Could not find apax.yml at ${filePath}`);
    return undefined;
  }

  const yamlContent = readFileSync(filePath, "utf8");
  if (yamlContent.trim().length === 0) {
    logger.error(`Could not find content in ${filePath}`);
    return undefined;
  }

  const document = parse(yamlContent) as unknown;
  const projectType = readScalar(document, "type");
  if (projectType === undefined) {
    logger.error(`Failed to read project type from APAX configuration: ${filePath}`);
    return undefined;
  }

  const values = createApaxValues({ projectType: projectType.trim() });
  if (!isOptionalScalarMapping(document, "registries")) {
    logger.error(`Failed to read registries from APAX configuration: ${filePath}`);
    return undefined;
  }
  if (!isOptionalScalarMapping(document, "publicKeys")) {
    logger.error(`Failed to read public keys from APAX configuration: ${filePath}`);
    return undefined;
  }
  values.registries = readMapping(document, "registries") ?? {};
  values.publicKeys = readMapping(document, "publicKeys") ?? {};
  if (values.projectType.toLocaleLowerCase("en-US") === "workspace") {
    return createApaxConfig(values, filePath, yamlContent);
  }

  values.dependencies = readMapping(document, "dependencies") ?? {};
  values.devDependencies = readMapping(document, "devDependencies") ?? {};

  const devSdkVersion = getValue(values.devDependencies, "@ax/sdk");
  if (devSdkVersion?.trim()) {
    values.sdkVersion = devSdkVersion;
  }

  const sdkVersion = getValue(values.dependencies, "@ax/sdk");
  if (sdkVersion?.trim()) {
    values.sdkVersion = sdkVersion;
  }

  const catalogs = readMapping(document, "catalogs");
  if (catalogs === undefined || getValue(catalogs, "@ax/simatic-ax") === undefined) {
    logger.error("Failed to read catalog @ax/simatic-ax from apax.yml.");
    return undefined;
  }
  values.catalogs = catalogs;

  const targets = readSequence(document, "targets");
  if (targets === undefined) {
    logger.error(`Failed to read targets from APAX configuration: ${filePath}`);
    return undefined;
  }
  values.targets = targets;

  const buildArgsValue = readPath(document, ["variables", "APAX_BUILD_ARGS"]);
  const buildArgs = readSequence(document, "variables", "APAX_BUILD_ARGS");
  if (buildArgsValue !== undefined && buildArgs === undefined) {
    logger.error(
      `Failed to read variables.APAX_BUILD_ARGS from APAX configuration: ${filePath}. Expected a YAML sequence.`,
    );
    return undefined;
  }
  if (buildArgs !== undefined) {
    values.buildArgs = appendSequenceComments(
      yamlContent,
      buildArgs,
      "variables",
      "APAX_BUILD_ARGS",
    );
  }

  values.binFolder = readScalar(document, "variables", "BIN_FOLDER") ?? "";
  return createApaxConfig(values, filePath, yamlContent);
}

function readMapping(document: unknown, ...path: string[]): StringMapping | undefined {
  const value = readPath(document, path);
  if (!isMapping(value)) {
    return undefined;
  }

  const mapping: StringMapping = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 0) {
      mapping[key] = scalarToString(item);
    }
  }
  return mapping;
}

function readSequence(document: unknown, ...path: string[]): string[] | undefined {
  const value = readPath(document, path);
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .map(scalarToString)
    .filter((item) => item.trim().length > 0);
}

function readScalar(document: unknown, ...path: string[]): string | undefined {
  const value = readPath(document, path);
  if (value === undefined) {
    return undefined;
  }

  const scalar = scalarToString(value);
  return scalar.trim().length > 0 ? scalar : undefined;
}

function readPath(document: unknown, path: readonly string[]): unknown {
  let current = document;
  for (const key of path) {
    if (!isMapping(current)) {
      return undefined;
    }
    const matchingKey = Object.keys(current).find((candidate) =>
      candidate.toLocaleLowerCase("en-US") === key.toLocaleLowerCase("en-US")
    );
    if (matchingKey === undefined) {
      return undefined;
    }
    current = current[matchingKey];
  }
  return current;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalScalarMapping(document: unknown, key: string): boolean {
  const value = readPath(document, [key]);
  return value === undefined || (
    isMapping(value)
    && Object.values(value).every((item) =>
      item === null || ["string", "number", "boolean"].includes(typeof item)
    )
  );
}

function scalarToString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function appendSequenceComments(
  yamlContent: string,
  values: readonly string[],
  ...path: string[]
): string[] {
  const comments = readSequenceCommentsFromContent(yamlContent, path);
  return values.map((value, index) => {
    const comment = comments[index];
    return comment?.trim() ? `${value} ${comment}` : value;
  });
}

function readSequenceCommentsFromContent(
  yamlContent: string,
  path: readonly string[],
): Array<string | undefined> {
  const lines = yamlContent.split(/\r?\n/);
  let searchStart = 0;
  let parentIndent = -1;

  for (const pathPart of path) {
    const keyPattern = new RegExp(
      `^(?<indent>\\s*)${escapeRegExp(pathPart)}\\s*:\\s*(?:#.*)?$`,
      "i",
    );
    let foundIndex = -1;
    for (let index = searchStart; index < lines.length; index++) {
      const line = lines[index] ?? "";
      const match = keyPattern.exec(line);
      const indent = match?.groups?.["indent"]?.length;
      if (indent === undefined || indent <= parentIndent) {
        continue;
      }

      foundIndex = index;
      parentIndent = indent;
      searchStart = index + 1;
      break;
    }

    if (foundIndex < 0) {
      return [];
    }
  }

  const comments: Array<string | undefined> = [];
  for (let index = searchStart; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (indent <= parentIndent) {
      break;
    }

    const trimmed = line.trimStart();
    if (trimmed.startsWith("- ")) {
      comments.push(getCompilerOptionInlineComment(trimmed.slice(2)));
    }
  }
  return comments;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}