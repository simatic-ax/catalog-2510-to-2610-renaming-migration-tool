import { describe, expect, it } from "vitest";
import { catalogs, dependencies } from "../src/mappings/catalog-2610.js";

describe("Catalog 2610 mappings", () => {
  it("contains every active dependency and catalog mapping", () => {
    expect(dependencies).toHaveLength(132);
    expect(catalogs).toHaveLength(1);
  });

  it("has unique oldName values case-insensitively", () => {
    const oldNames = [...dependencies, ...catalogs].map(({ oldName }) => oldName.toLowerCase());

    expect(new Set(oldNames).size).toBe(oldNames.length);
  });

  it("preserves representative dependency mappings", () => {
    expect(dependencies).toContainEqual({
      newName: "@ax-as/s7-1500-ax2tia",
      oldName: "@ax/ax2tia",
    });
    expect(dependencies).toContainEqual({
      newName: "@ax-as/build-native-linux-x64",
      oldName: "@ax/build-native-linux",
    });
    expect(dependencies).toContainEqual({
      newName: "@ax-as/s7-sdk",
      oldName: "@ax/sdk",
    });
  });

  it("contains the approved hardware and motion-control mappings", () => {
    expect(dependencies).toEqual(expect.arrayContaining([
      { newName: "@ax-as/axrt-pn-hw", oldName: "@ax/hw-sdc-pnapp" },
      { newName: "@ax-mc/s7-motioncontrol-v10-lib", oldName: "@ax/simatic-motioncontrol-native-v10" },
      { newName: "@ax-mc/s7-axisctrl-v10-lib", oldName: "@ax/simatic-motioncontrol-v10" },
    ]));
  });

  it("stores only source and target package names", () => {
    for (const mapping of dependencies) {
      expect(Object.keys(mapping).sort()).toEqual(["newName", "oldName"]);
    }
  });

  it("preserves the catalog mapping", () => {
    expect(catalogs[0]).toEqual({
      newName: "@ax-as/s7-catalog",
      oldName: "@ax/simatic-ax",
    });
  });
});