import type { ApaxConfig } from "../domain/apax-config.js";
import { catalogs, dependencies, type PackageMapping } from "../mappings/catalog-2610.js";
import { YamlTextEditor } from "./yaml-text-editor.js";

const dependencyRenames = buildRenameMap(dependencies);
const catalogRenames = buildRenameMap(catalogs);

export function writeApax(config: ApaxConfig): string {
  const editor = new YamlTextEditor(config.originalContent);
  updateMappingWhenPresentOrPopulated(
    editor,
    config.originalContent,
    "dependencies",
    config.migrated.dependencies,
    dependencyRenames,
  );
  updateMappingWhenPresentOrPopulated(
    editor,
    config.originalContent,
    "devDependencies",
    config.migrated.devDependencies,
    dependencyRenames,
  );
  editor.updateMapping("catalogs", config.migrated.catalogs, catalogRenames);
  editor.removeSection("targets");
  editor.removeMappingEntries("variables", "APAX_BUILD_ARGS");
  return editor.content;
}

function updateMappingWhenPresentOrPopulated(
  editor: YamlTextEditor,
  originalContent: string,
  sectionName: string,
  values: Readonly<Record<string, string>>,
  renameMap: Readonly<Record<string, string>>,
): void {
  const sectionPattern = new RegExp(`^${sectionName}\\s*:`, "im");
  if (sectionPattern.test(originalContent) || Object.keys(values).length > 0) {
    editor.updateMapping(sectionName, values, renameMap);
  }
}

function buildRenameMap(mappings: readonly PackageMapping[]): Readonly<Record<string, string>> {
  return Object.fromEntries(mappings.map((mapping) => [mapping.oldName, mapping.newName]));
}