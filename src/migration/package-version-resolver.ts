import type { ApaxConfig, StringMapping } from "../domain/apax-config.js";
import type { Logger } from "../domain/logger.js";
import type { ApaxCommandRunner } from "../io/apax-command-runner.js";
import { findKey } from "../mappings/case-insensitive-map.js";

const packageVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export async function resolvePackageVersions(
  config: ApaxConfig,
  packageNames: readonly string[],
  workingDirectory: string,
  runApax: ApaxCommandRunner,
  logger: Logger,
): Promise<boolean> {
  for (const packageName of packageNames) {
    logger.info(`Getting the version of ${packageName}`);
    try {
      const result = await runApax(["list", "-p", packageName], workingDirectory);
      const version = readPackageVersion(result.stdout);
      if (result.exitCode !== 0 || version === undefined) {
        logger.error(`APAX list failed: ${packageName}`);
        setLatestVersion(config, packageName);
        continue;
      }

      updateVersion(config.migrated.dependencies, packageName, version);
      updateVersion(config.migrated.devDependencies, packageName, version);
    } catch {
      logger.error(`APAX list failed: ${packageName}`);
      setLatestVersion(config, packageName);
    }
  }
  return true;
}

function setLatestVersion(config: ApaxConfig, packageName: string): void {
  setVersion(config.migrated.dependencies, packageName, "latest");
  setVersion(config.migrated.devDependencies, packageName, "latest");
}

export function applyCatalogVersions(
  config: ApaxConfig,
  packageNames: readonly string[],
  catalogDependencies: Readonly<StringMapping>,
): string[] {
  const nonCatalogPackages: string[] = [];
  for (const packageName of packageNames) {
    const catalogKey = findKey(catalogDependencies, packageName);
    if (catalogKey === undefined) {
      nonCatalogPackages.push(packageName);
      continue;
    }

    const version = catalogDependencies[catalogKey];
    if (version === undefined) {
      nonCatalogPackages.push(packageName);
      continue;
    }
    updateVersion(config.migrated.dependencies, packageName, version);
    updateVersion(config.migrated.devDependencies, packageName, version);
  }
  return nonCatalogPackages;
}

function readPackageVersion(output: string): string | undefined {
  const trimmed = output.trim();
  if (packageVersionPattern.test(trimmed)) {
    return trimmed;
  }

  const latest = /^\s*-?\s*latest:\s*(\S+)\s*$/imu.exec(output)?.[1];
  return latest !== undefined && packageVersionPattern.test(latest) ? latest : undefined;
}

function updateVersion(mapping: StringMapping, packageName: string, version: string): void {
  const key = findKey(mapping, packageName);
  if (key !== undefined) {
    const currentVersion = mapping[key]?.trim() ?? "";
    const compatibility = currentVersion.startsWith("^")
      ? "^"
      : currentVersion.startsWith("~")
      ? "~"
      : "";
    mapping[key] = `${compatibility}${version}`;
  }
}

function setVersion(mapping: StringMapping, packageName: string, version: string): void {
  const key = findKey(mapping, packageName);
  if (key !== undefined) {
    mapping[key] = version;
  }
}

