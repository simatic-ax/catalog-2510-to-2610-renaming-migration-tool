import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { createApaxConfig } from "../src/domain/apax-config.js";
import { writeCatalogPreflight } from "../src/io/catalog-preflight-writer.js";

describe("writeCatalogPreflight", () => {
  it("writes only identity and independently present registry settings", () => {
    const config = createApaxConfig({
      registries: { "@ax-as": "https://registry.example.test/" },
    });

    expect(parse(writeCatalogPreflight(config.original))).toEqual({
      name: "catalogmigrate",
      version: "0.0.1",
      type: "app",
      registries: { "@ax-as": "https://registry.example.test/" },
    });
  });

  it("copies public keys without requiring registries", () => {
    const config = createApaxConfig({ publicKeys: { "@ax-as": "" } });

    expect(parse(writeCatalogPreflight(config.original))).toEqual({
      name: "catalogmigrate",
      version: "0.0.1",
      type: "app",
      publicKeys: { "@ax-as": "" },
    });
  });
});