import type { ApaxConfig, StringMapping } from "../domain/apax-config.js";
import type { Logger } from "../domain/logger.js";
import { catalogs, dependencies } from "../mappings/catalog-2610.js";
import {
  buildCaseInsensitiveMap,
  deleteKey,
  findKey,
  getValue,
} from "../mappings/case-insensitive-map.js";

const sourceCatalogName = "@ax/simatic-ax";
const migrationToolPackage = "@simatic-ax/catalog-2510-to-2610-renaming-migration-tool";
const dependencyMappings = buildCaseInsensitiveMap(dependencies, (item) => item.oldName);
const catalogMappings = buildCaseInsensitiveMap(catalogs, (item) => item.oldName);

export interface ApaxMigrationResult {
  readonly mappedPackages: readonly string[];
}

export function migrateApax(
  config: ApaxConfig,
  logger: Logger,
  targetCatalogName = "@ax-as/s7-catalog",
  targetCatalogVersion = "latest",
): ApaxMigrationResult | undefined {
  const sourceKey = findKey(config.migrated.catalogs, sourceCatalogName);
  const sourceVersion = getValue(config.migrated.catalogs, sourceCatalogName);
  if (sourceKey === undefined || sourceVersion === undefined) {
    logger.error(`The ${sourceCatalogName} catalog version is missing.`);
    return undefined;
  }

  const version = readSourceVersion(sourceVersion);
  if (version === undefined) {
    logger.error(
      `Current catalog version is ${sourceVersion}; only catalog versions matching 2510.x.y can be migrated.`,
    );
    return undefined;
  }

  logger.info(
    `Current catalog version is ${sourceVersion}, migrating to ${targetCatalogName}@${targetCatalogVersion}.`,
  );
  const mappedPackages = new Set<string>();
  config.migrated.devDependencies = migrateDependencies(
    config.migrated.devDependencies,
    mappedPackages,
  );
  config.migrated.dependencies = migrateDependencies(
    config.migrated.dependencies,
    mappedPackages,
  );
  deleteKey(config.migrated.dependencies, migrationToolPackage);
  deleteKey(config.migrated.devDependencies, migrationToolPackage);

  const targetCatalog = getValue(catalogMappings, sourceCatalogName);
  if (targetCatalog === undefined) {
    throw new Error(`Missing catalog migration mapping for '${sourceCatalogName}'.`);
  }
  delete config.migrated.catalogs[sourceKey];
  config.migrated.catalogs[targetCatalogName] = targetCatalogVersion;
  return { mappedPackages: [...mappedPackages] };
}

function readSourceVersion(value: string): string | undefined {
  const trimmed = value.trim();
  const version = trimmed.replace(/^[~^]/u, "");
  return /^2510\.\d+\.\d+$/.test(version) ? version : undefined;
}

function migrateDependencies(
  source: Readonly<StringMapping>,
  mappedPackages: Set<string>,
): StringMapping {
  const migrated = { ...source };
  for (const [name, oldVersion] of Object.entries(source)) {
    const mapping = getValue(dependencyMappings, name);
    if (mapping === undefined) {
      continue;
    }
    deleteKey(migrated, name);
    migrated[mapping.newName] = oldVersion;
    mappedPackages.add(mapping.newName);
  }
  return migrated;
}