import { describe, expect, it } from "vitest";
import {
  getCompilerOptionInlineComment,
  isListCompilerOption,
  resolveCompilerOptions,
  resolveCompilerOptionsWithComments,
} from "../src/migration/compiler-option-resolver.js";

describe("compiler option resolver", () => {
  it("maps debug, format, input, output, and native target values", () => {
    const buildArguments = [
      "--debug # Enable debug information for value debugging",
      "-f Text",
      '-i "./mysrc"',
      '--output "./artifacts" # Compiler output',
      "--native-target x86_64-pc-windows-msvc",
    ];

    const result = resolveCompilerOptions(buildArguments);
    const detailed = resolveCompilerOptionsWithComments(buildArguments);

    expect(result).toEqual({
      Debug: "true",
      OutputFormat: "Text",
      InputDirectories: "./mysrc",
      OutputDirectory: "./artifacts",
      LlvmTarget: "x86_64-pc-windows-msvc",
    });
    expect(detailed.find((option) => option.name === "Debug")?.comment).toBe(
      "# Enable debug information for value debugging",
    );
    expect(detailed.find((option) => option.name === "OutputDirectory")?.comment).toBe(
      "# Compiler output",
    );
  });

  it("resolves APAX build argument strings and preserves inline comments", () => {
    const buildArguments = [
      "--debug # Enable debug information for value debugging",
      "-f Text",
      '-i "./mysrc"',
    ];

    expect(resolveCompilerOptions(buildArguments)).toEqual({
      Debug: "true",
      OutputFormat: "Text",
      InputDirectories: "./mysrc",
    });
    expect(getCompilerOptionInlineComment(buildArguments[0] ?? "")).toBe(
      "# Enable debug information for value debugging",
    );
  });

  it("uses an output option value and preserves its comment", () => {
    const detailed = resolveCompilerOptionsWithComments([
      "-o ./artifacts # Compiler output",
    ]);

    expect(detailed).toEqual([
      {
        name: "OutputDirectory",
        value: "./artifacts",
        comment: "# Compiler output",
      },
    ]);
  });

  it("emits every repeated list option value", () => {
    const detailed = resolveCompilerOptionsWithComments([
      "--input ./src",
      "--input ./generated",
      "--lib ./lib/core",
      "--lib ./lib/shared",
      "--enable-feature records",
      "--enable-feature interfaces",
      "--directive DEBUG",
      "--directive TRACE",
    ]);

    expect(detailed.map(({ name, value }) => [name, value])).toEqual([
      ["InputDirectories", "./src"],
      ["InputDirectories", "./generated"],
      ["Libraries", "./lib/core"],
      ["Libraries", "./lib/shared"],
      ["EnablePrototypeFeatures", "records"],
      ["EnablePrototypeFeatures", "interfaces"],
      ["Directives", "DEBUG"],
      ["Directives", "TRACE"],
    ]);
  });

  it("matches quoting, comments, inline values, and scalar replacement semantics", () => {
    const detailed = resolveCompilerOptionsWithComments([
      '--output "./first # retained" # first comment',
      "--unknown ignored",
      "--output=./second # final comment",
      "--debug -not-a-value",
      "--input ''",
    ]);

    expect(detailed).toEqual([
      { name: "OutputDirectory", value: "./second", comment: "# final comment" },
      { name: "Debug", value: "true", comment: undefined },
      { name: "InputDirectories", value: "", comment: undefined },
    ]);
    expect(resolveCompilerOptions(detailed.map((option) => `${option.name} ${option.value}`))).toEqual(
      {},
    );
    expect(isListCompilerOption("inputDIRECTORIES")).toBe(true);
    expect(isListCompilerOption("OutputDirectory")).toBe(false);
  });
});