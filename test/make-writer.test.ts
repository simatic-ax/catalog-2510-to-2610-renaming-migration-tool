import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { createApaxConfig } from "../src/domain/apax-config.js";
import { writeMake } from "../src/io/make-writer.js";

interface MakeConfiguration {
  Name: string;
  Type: string;
  Targets: string[];
  OutputDirectory?: string;
  StCompiler: Record<string, unknown>;
}

describe("writeMake", () => {
  it("creates one configuration with normalized, deduplicated, ordered targets", () => {
    const result = writeMake(createApaxConfig({
      projectType: "app",
      targets: ["LLVM", "1500", "s7", "llvm"],
      buildArgs: ["--debug"],
    }));
    const configuration = readConfiguration(result);

    expect(configuration).toMatchObject({
      Name: "my_s7_compilation",
      Type: "app",
      Targets: ["s7", "llvm"],
      StCompiler: { Debug: true },
    });
    expect(parse(result).MakeConfiguration).toHaveLength(1);
    expect(result).not.toContain("my_llvm_compilation");
    expect(configuration).not.toHaveProperty("OutputDirectory");
    expect(configuration.StCompiler).not.toHaveProperty("LoggingVerbosity");
    expect(configuration.StCompiler).not.toHaveProperty("Devirtualization");
    expect(configuration.StCompiler).not.toHaveProperty("AdditionalHints");
  });

  it("defaults Debug to false and omits an empty output directory", () => {
    const configuration = readConfiguration(writeMake(createApaxConfig({
      targets: ["1500", "llvm"],
      buildArgs: ["--output ''"],
    })));

    expect(configuration.StCompiler).toEqual({
      Debug: false,
    });
    expect(configuration).not.toHaveProperty("OutputDirectory");
  });

  it("emits scalar and list options in the expected YAML shape", () => {
    const result = writeMake(createApaxConfig({
      targets: ["llvm", "wasm"],
      buildArgs: [
        "-f Text",
        "-O true",
        "--log Debug",
        "--sym-format Json",
        "--input ./src",
        "--input ./generated",
        "--lib ./lib/core",
        "--lib ./lib/shared",
        "--enable-feature records",
        "--enable-feature interfaces",
        "--directive DEBUG",
        "--directive true",
        "--native-target x86_64_pc_windows_msvc",
        "--generate-runtime-checks",
        "--static-link-ir ./lib/runtime.ir",
        "--static-link-ir ./lib/math.ir",
        "--simulation",
      ],
    }));
    const compiler = readConfiguration(result).StCompiler;

    expect(compiler).toEqual({
      OutputFormat: "Text",
      OptimizationLevel: "Full",
      LoggingVerbosity: "Debug",
      SymbolInfoFormat: "Json",
      InputDirectories: ["./src", "./generated"],
      Libraries: ["./lib/core", "./lib/shared"],
      EnablePrototypeFeatures: ["records", "interfaces"],
      Directives: ["DEBUG", "true"],
      Llvm: {
        LlvmTarget: "x86_64_pc_windows_msvc",
        EnableRuntimeChecks: true,
        StaticLinkIr: ["./lib/runtime.ir", "./lib/math.ir"],
      },
      Wasm: {
        EnableRuntimeChecks: true,
        StaticLinkIr: ["./lib/runtime.ir", "./lib/math.ir"],
      },
      Debug: false,
    });
    expect(compiler).not.toHaveProperty("EnableSimulation");
    expect(result).toContain("InputDirectories:\n");
    expect(result).toContain("      - ./src");
  });

  it("converts optimization booleans to schema string values", () => {
    const trueLevel = readConfiguration(writeMake(createApaxConfig({
      targets: ["llvm"],
      buildArgs: ["-O true"],
    })));
    const falseLevel = readConfiguration(writeMake(createApaxConfig({
      targets: ["llvm"],
      buildArgs: ["-O false"],
    })));

    expect(trueLevel.StCompiler.OptimizationLevel).toBe("Full");
    expect(falseLevel.StCompiler.OptimizationLevel).toBe("None");
  });

  it("writes schema enum values with canonical casing", () => {
    const configuration = readConfiguration(writeMake(createApaxConfig({
      targets: ["llvm"],
      buildArgs: ["--log debug", "--sym-format json", "-f binary", "-O full"],
    })));

    expect(configuration.StCompiler).toMatchObject({
      LoggingVerbosity: "Debug",
      SymbolInfoFormat: "Json",
      OutputFormat: "Binary",
      OptimizationLevel: "Full",
    });
  });

  it("omits backend sections when targets do not include LLVM or WASM", () => {
    const configuration = readConfiguration(writeMake(createApaxConfig({
      targets: ["1500"],
      buildArgs: ["--native-target x86_64_pc_windows_msvc"],
    })));

    expect(configuration.StCompiler).not.toHaveProperty("Llvm");
    expect(configuration.StCompiler).not.toHaveProperty("Wasm");
  });

  it("routes native targets only to a matching configured backend", () => {
    const configuration = readConfiguration(writeMake(createApaxConfig({
      targets: ["llvm", "wasm"],
      buildArgs: ["--native-target wasm32_unknown_wasi_threads"],
    })));

    expect(configuration.StCompiler).not.toHaveProperty("Llvm");
    expect(configuration.StCompiler.Wasm).toEqual({
      LlvmTarget: "wasm32_unknown_wasi_threads",
    });
  });

  it("keeps one native target per backend", () => {
    const configuration = readConfiguration(writeMake(createApaxConfig({
      targets: ["llvm", "wasm"],
      buildArgs: [
        "--native-target independent",
        "--native-target x86_64_pc_windows_msvc",
        "--native-target wasm32_unknown_wasi_threads",
      ],
    })));

    expect(configuration.StCompiler.Llvm).toEqual({
      LlvmTarget: "x86_64_pc_windows_msvc",
    });
    expect(configuration.StCompiler.Wasm).toEqual({
      LlvmTarget: "wasm32_unknown_wasi_threads",
    });
  });

  it("canonicalizes Independent and omits native targets for absent backends", () => {
    const llvmConfiguration = readConfiguration(writeMake(createApaxConfig({
      targets: ["llvm"],
      buildArgs: ["--native-target independent"],
    })));
    const linuxConfiguration = readConfiguration(writeMake(createApaxConfig({
      targets: ["llvm"],
      buildArgs: ["--native-target x86_64_pc_linux_gnu"],
    })));
    const wasmConfiguration = readConfiguration(writeMake(createApaxConfig({
      targets: ["wasm"],
      buildArgs: ["--native-target x86_64_pc_windows_msvc"],
    })));

    expect(llvmConfiguration.StCompiler.Llvm).toEqual({ LlvmTarget: "Independent" });
    expect(linuxConfiguration.StCompiler.Llvm).toEqual({
      LlvmTarget: "x86_64_pc_linux_gnu",
    });
    expect(wasmConfiguration.StCompiler).not.toHaveProperty("Wasm");
  });

  it("places S7 parallelization settings in the S7 section", () => {
    const configuration = readConfiguration(writeMake(createApaxConfig({
      targets: ["1500"],
      buildArgs: ["--disable-parallelization"],
    })));

    expect(configuration.StCompiler.S7).toEqual({ DisableParallelization: true });
    expect(configuration.StCompiler).not.toHaveProperty("DisableParallelization");
    expect(configuration.StCompiler).not.toHaveProperty("Llvm");
    expect(configuration.StCompiler).not.toHaveProperty("Wasm");
  });

  it("omits S7 parallelization settings for non-S7 targets", () => {
    const configuration = readConfiguration(writeMake(createApaxConfig({
      targets: ["llvm"],
      buildArgs: ["--disable-parallelization"],
    })));

    expect(configuration.StCompiler).not.toHaveProperty("S7");
    expect(configuration.StCompiler).not.toHaveProperty("DisableParallelization");
  });

  it("places output directory on the configuration and preserves comments", () => {
    const result = writeMake(createApaxConfig({
      targets: ["1500"],
      buildArgs: [
        "--debug # Enable debug information for value debugging",
        "-o ./artifacts # Compiler output",
      ],
    }));
    const configuration = readConfiguration(result);

    expect(configuration.OutputDirectory).toBe("./artifacts");
    expect(configuration.StCompiler).toMatchObject({ Debug: true });
    expect(result).toContain(
      "Debug: true # Enable debug information for value debugging",
    );
    expect(result).toContain("OutputDirectory: ./artifacts # Compiler output");
    expect(result.match(/OutputDirectory:/g)).toHaveLength(1);
  });
});

function readConfiguration(content: string): MakeConfiguration {
  const document = parse(content) as { MakeConfiguration: MakeConfiguration[] };
  const configuration = document.MakeConfiguration[0];
  expect(configuration).toBeDefined();
  return configuration as MakeConfiguration;
}