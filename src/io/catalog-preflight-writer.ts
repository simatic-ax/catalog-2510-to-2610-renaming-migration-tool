import { stringify } from "yaml";
import type { ApaxSnapshot } from "../domain/apax-config.js";

export function writeCatalogPreflight(config: ApaxSnapshot): string {
  const document: Record<string, unknown> = {
    name: "catalogmigrate",
    version: "0.0.1",
    type: "app",
  };

  if (Object.keys(config.registries).length > 0) {
    document.registries = config.registries;
  }
  if (Object.keys(config.publicKeys).length > 0) {
    document.publicKeys = config.publicKeys;
  }

  return stringify(document, { lineWidth: 0 });
}