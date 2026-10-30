export type CatalogCompatibility = "caret" | "exact" | "tilde";

export interface CatalogOptions {
  readonly compatibility: CatalogCompatibility;
  readonly name: string;
  readonly version: string;
}

export const defaultCatalogOptions: CatalogOptions = {
  compatibility: "caret",
  name: "@ax-as/s7-catalog",
  version: "latest",
};

export interface CatalogReference {
  readonly name: string;
  readonly version: string;
}

const catalogNamePattern = /^@[0-9A-Za-z][0-9A-Za-z._-]*\/[0-9A-Za-z][0-9A-Za-z._-]*$/;
const catalogVersionPattern = /^(?:latest|2610\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

export function parseCatalogReference(value: string): CatalogReference | undefined {
  const trimmed = value.trim();
  if (catalogVersionPattern.test(trimmed)) {
    return { name: defaultCatalogOptions.name, version: trimmed };
  }

  const versionSeparator = trimmed.lastIndexOf("@");
  if (versionSeparator <= 0) {
    return undefined;
  }

  const name = trimmed.slice(0, versionSeparator);
  const version = trimmed.slice(versionSeparator + 1);
  return catalogNamePattern.test(name) && catalogVersionPattern.test(version)
    ? { name, version }
    : undefined;
}
