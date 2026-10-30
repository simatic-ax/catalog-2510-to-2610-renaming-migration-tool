import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { ApaxSnapshot, StringMapping } from "../domain/apax-config.js";
import type { CatalogOptions } from "../domain/catalog-options.js";
import type { Logger } from "../domain/logger.js";
import type { ApaxCommandRunner } from "../io/apax-command-runner.js";
import { writeCatalogPreflight } from "../io/catalog-preflight-writer.js";
import { findKey } from "../mappings/case-insensitive-map.js";

export interface ResolvedCatalog {
  readonly dependencies: Readonly<StringMapping>;
  readonly name: string;
  readonly version: string;
}

export async function acquireCatalog(
  source: ApaxSnapshot,
  options: CatalogOptions,
  runApax: ApaxCommandRunner,
  logger: Logger,
  catalogsRoot?: string,
): Promise<ResolvedCatalog | undefined> {
  const catalog = `${options.name}@${options.version}`;
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "catalog-migrate-"));
  logger.info(`Getting catalog ${catalog}...`);

  try {
    const apaxPath = join(temporaryDirectory, "apax.yml");
    writeFileSync(apaxPath, writeCatalogPreflight(source), "utf8");
    const compatibilityArguments = options.compatibility === "caret"
      ? []
      : [`--${options.compatibility}`];
    const result = await runApax(
      ["add", "--catalog", catalog, ...compatibilityArguments],
      temporaryDirectory,
    );
    if (result.exitCode !== 0) {
      logCatalogFailure(logger, catalog, result.stderr || result.stdout);
      return undefined;
    }

    const resolvedVersion = readResolvedVersion(apaxPath, options.name);
    if (resolvedVersion === undefined) {
      logCatalogFailure(logger, catalog, "APAX did not return a resolved catalog version.");
      return undefined;
    }
    const effectiveCatalogsRoot = catalogsRoot ?? join(temporaryDirectory, ".apax", "catalogs");
    const dependencies = readCatalogDependencies(
      effectiveCatalogsRoot,
      options.name,
      resolvedVersion,
    );
    if (dependencies === undefined) {
      logCatalogFailure(
        logger,
        catalog,
        "Resolved catalog metadata was not found in the APAX package cache.",
      );
      return undefined;
    }

    logger.info(`Getting catalog succeeded: ${options.name}@${resolvedVersion}`);
    return { dependencies, name: options.name, version: resolvedVersion };
  } catch (error) {
    logCatalogFailure(logger, catalog, error instanceof Error ? error.message : String(error));
    return undefined;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function logCatalogFailure(logger: Logger, catalog: string, detail: string): void {
  const normalizedDetail = detail.replace(/\s+/gu, " ").trim();
  logger.error(
    normalizedDetail.length > 0
      ? `Getting catalog failed: ${catalog}. ${normalizedDetail}`
      : `Getting catalog failed: ${catalog}`,
  );
}

function readResolvedVersion(apaxPath: string, catalogName: string): string | undefined {
  const document = parse(readFileSync(apaxPath, "utf8")) as unknown;
  if (!isMapping(document) || !isMapping(document.catalogs)) {
    return undefined;
  }

  const key = findKey(document.catalogs, catalogName);
  const value = key === undefined ? undefined : document.catalogs[key];
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const version = String(value).trim().replace(/^[~^]/u, "");
  return version.length > 0 && version !== "latest" ? version : undefined;
}

function readCatalogDependencies(
  catalogsRoot: string,
  catalogName: string,
  version: string,
): StringMapping | undefined {
  const manifestPath = join(catalogsRoot, ...catalogName.split("/"), version, "apax.yml");
  const manifest = readCatalogManifest(manifestPath);
  if (
    manifest === undefined
    || manifest.name.toLocaleLowerCase("en-US") !== catalogName.toLocaleLowerCase("en-US")
    || manifest.version !== version
  ) {
    return undefined;
  }
  return manifest.dependencies;
}

interface CatalogManifest {
  readonly dependencies: StringMapping;
  readonly name: string;
  readonly version: string;
}

function readCatalogManifest(path: string): CatalogManifest | undefined {
  try {
    const document = parse(readFileSync(path, "utf8")) as unknown;
    if (
      !isMapping(document)
      || typeof document.name !== "string"
      || (typeof document.version !== "string" && typeof document.version !== "number")
      || !isMapping(document.catalogDependencies)
    ) {
      return undefined;
    }

    const dependencies: StringMapping = {};
    for (const [name, value] of Object.entries(document.catalogDependencies)) {
      if (name.trim().length === 0 || (typeof value !== "string" && typeof value !== "number")) {
        return undefined;
      }
      const version = String(value).trim();
      if (version.length === 0) {
        return undefined;
      }
      dependencies[name] = version;
    }
    return { dependencies, name: document.name, version: String(document.version) };
  } catch {
    return undefined;
  }
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type CatalogAcquirer = typeof acquireCatalog;