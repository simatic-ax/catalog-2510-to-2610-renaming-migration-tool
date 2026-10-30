import { describe, expect, it } from "vitest";
import { parseCatalogReference } from "../src/domain/catalog-options.js";

describe("parseCatalogReference", () => {
  it.each([
    ["latest", { name: "@ax-as/s7-catalog", version: "latest" }],
    ["2610.0.0", { name: "@ax-as/s7-catalog", version: "2610.0.0" }],
    ["2610.0.0-rc.1", { name: "@ax-as/s7-catalog", version: "2610.0.0-rc.1" }],
    ["@domain/catalog@latest", { name: "@domain/catalog", version: "latest" }],
    [
      "@domain/catalog@2610.0.0-rc.1",
      { name: "@domain/catalog", version: "2610.0.0-rc.1" },
    ],
  ])("parses %s", (value, expected) => {
    expect(parseCatalogReference(value)).toEqual(expected);
  });

  it.each([
    "",
    "beta",
    "2610",
    "2610.0",
    "2510.20.0",
    "2611.0.0",
    "domain/catalog@2610.0.0",
    "@domain/catalog",
    "@domain/catalog@2510.20.0",
    "@domain/catalog@beta",
    "@domain/catalog@latest;echo-bad",
  ])("rejects %s", (value) => {
    expect(parseCatalogReference(value)).toBeUndefined();
  });
});
