import { describe, expect, it } from "vitest";
import { YamlTextEditor } from "../src/io/yaml-text-editor.js";

describe("YamlTextEditor", () => {
  it("preserves CRLF, quotes, comments, and section order when updating a mapping", () => {
    const yaml = "dependencies:\r\n  '@ax/system': '^10.2.7' # keep this\r\nscripts:\r\n  build: apax build\r\n";
    const editor = new YamlTextEditor(yaml);

    editor.updateMapping(
      "dependencies",
      { "@ax-as/system-lib": "^10.4.20" },
      { "@ax/system": "@ax-as/system-lib" },
    );

    expect(editor.content).toBe(
      "dependencies:\r\n  '@ax-as/system-lib': '^10.4.20' # keep this\r\nscripts:\r\n  build: apax build\r\n",
    );
    expect(editor.content.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("appends a missing mapping section", () => {
    const editor = new YamlTextEditor("name: sample\n");

    editor.updateMapping(
      "dependencies",
      { "@ax-as/system-lib": "^10.4.20" },
      {},
    );

    expect(editor.content).toContain(
      "dependencies:\n  \"@ax-as/system-lib\": ^10.4.20",
    );
  });

  it("preserves an unrelated nested entry when removing mapping entries", () => {
    const editor = new YamlTextEditor(
      [
        "variables:",
        "  APAX_BUILD_ARGS:",
        "    - --debug",
        "  SETTINGS:",
        "    mode: safe",
        "  BIN_FOLDER: ./bin",
        "scripts:",
        "  build: apax build",
      ].join("\n"),
    );

    editor.removeMappingEntries("variables", "APAX_BUILD_ARGS", "BIN_FOLDER");

    expect(editor.content).not.toContain("APAX_BUILD_ARGS");
    expect(editor.content).not.toContain("BIN_FOLDER");
    expect(editor.content).toContain("SETTINGS:");
    expect(editor.content).toContain("mode: safe");
    expect(editor.content).toContain("scripts:");
  });

  it("removes a mapping section when no entries remain", () => {
    const editor = new YamlTextEditor("variables:\nscripts:\n  build: apax build\n");

    editor.removeMappingEntries("variables", "APAX_BUILD_ARGS");

    expect(editor.content).toBe("scripts:\n  build: apax build\n");
  });

  it("leaves content unchanged when removing missing sections", () => {
    const yaml = "name: sample\n";
    const editor = new YamlTextEditor(yaml);

    editor.removeSection("targets");
    editor.removeMappingEntries("variables", "BIN_FOLDER");

    expect(editor.content).toBe(yaml);
  });
});