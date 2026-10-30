import { stringify } from "yaml";
import type { ApaxConfig } from "../domain/apax-config.js";
import {
  isListCompilerOption,
  resolveCompilerOptionsWithComments,
  type ResolvedCompilerOption,
} from "../migration/compiler-option-resolver.js";

export function writeMake(config: ApaxConfig): string {
  const values = config.migrated;
  const resolvedOptions = resolveCompilerOptionsWithComments(values.buildArgs);
  const outputDirectory = resolvedOptions.find(
    (option) => option.name === "OutputDirectory",
  )?.value;
  const compilerOptions = resolvedOptions.filter(
    (option) => option.name !== "OutputDirectory",
  );
  const stCompiler = createStCompiler(compilerOptions, values.targets);

  if (!("Debug" in stCompiler)) {
    stCompiler.Debug = false;
  }

  const configuration: Record<string, unknown> = {
    Name: "my_s7_compilation",
    Type: values.projectType,
    Targets: normalizeTargets(values.targets),
  };
  if (outputDirectory !== undefined && outputDirectory.trim().length > 0) {
    configuration.OutputDirectory = outputDirectory;
  }
  configuration.StCompiler = stCompiler;

  return appendCompilerOptionComments(
    stringify({ MakeConfiguration: [configuration] }),
    resolvedOptions,
  );
}

function normalizeTargets(targets: readonly string[]): string[] {
  const normalized = new Map<string, string>();
  for (const target of targets) {
    const value = target.toLowerCase() === "1500" || target.toLowerCase() === "s7"
      ? "s7"
      : target.toLowerCase();
    if (!normalized.has(value.toLowerCase())) {
      normalized.set(value.toLowerCase(), value);
    }
  }

  return [...normalized.values()].sort((left, right) => {
    if (left === "s7") {
      return right === "s7" ? 0 : -1;
    }
    if (right === "s7") {
      return 1;
    }
    const normalizedLeft = left.toLowerCase();
    const normalizedRight = right.toLowerCase();
    return normalizedLeft < normalizedRight
      ? -1
      : normalizedLeft > normalizedRight
        ? 1
        : 0;
  });
}

function createStCompiler(
  options: readonly ResolvedCompilerOption[],
  targets: readonly string[],
): Record<string, unknown> {
  const grouped = new Map<string, ResolvedCompilerOption[]>();
  for (const option of options) {
    const key = option.name.toLowerCase();
    const group = grouped.get(key) ?? [];
    group.push(option);
    grouped.set(key, group);
  }

  const compiler: Record<string, unknown> = {};
  const s7Compiler: Record<string, unknown> = {};
  const llvmCompiler: Record<string, unknown> = {};
  const wasmCompiler: Record<string, unknown> = {};
  for (const group of grouped.values()) {
    const first = group[0];
    const last = group[group.length - 1];
    if (first === undefined || last === undefined) {
      continue;
    }
    if (first.name === "LlvmTarget") {
      for (const option of group) {
        const nativeTarget = resolveNativeTarget(option.value);
        if (nativeTarget !== undefined && hasTarget(targets, nativeTarget.backend)) {
          const backendCompiler = nativeTarget.backend === "llvm" ? llvmCompiler : wasmCompiler;
          backendCompiler.LlvmTarget = nativeTarget.value;
        }
      }
      continue;
    }

    const value = isListCompilerOption(first.name)
      ? group.map((option) => option.value)
      : toCompilerValue(first.name, last.value);
    if (isSharedBackendOption(first.name)) {
      if (hasTarget(targets, "llvm")) {
        llvmCompiler[first.name] = value;
      }
      if (hasTarget(targets, "wasm")) {
        wasmCompiler[first.name] = value;
      }
      continue;
    }
    const target = first.name === "DisableParallelization"
      ? s7Compiler
      : compiler;
    target[first.name] = value;
  }
  if (
    targets.some((target) => ["s7", "1500"].includes(target.toLowerCase()))
    && Object.keys(s7Compiler).length > 0
  ) {
    compiler.S7 = s7Compiler;
  }
  if (hasTarget(targets, "llvm") && Object.keys(llvmCompiler).length > 0) {
    compiler.Llvm = { ...llvmCompiler };
  }
  if (hasTarget(targets, "wasm") && Object.keys(wasmCompiler).length > 0) {
    compiler.Wasm = { ...wasmCompiler };
  }
  return compiler;
}

function resolveNativeTarget(value: string): {
  backend: "llvm" | "wasm";
  value: string;
} | undefined {
  const nativeTargets = new Map<string, { backend: "llvm" | "wasm"; value: string }>([
    ["independent", { backend: "llvm", value: "Independent" }],
    ["x86_64_pc_windows_msvc", { backend: "llvm", value: "x86_64_pc_windows_msvc" }],
    ["x86_64_pc_linux_gnu", { backend: "llvm", value: "x86_64_pc_linux_gnu" }],
    ["wasm32_unknown_wasi_threads", { backend: "wasm", value: "wasm32_unknown_wasi_threads" }],
  ]);
  return nativeTargets.get(value.toLowerCase())
    ?? invalidCompilerOptionValue("LlvmTarget", value);
}

function hasTarget(targets: readonly string[], expectedTarget: string): boolean {
  return targets.some((target) => target.toLowerCase() === expectedTarget);
}

function toCompilerValue(optionName: string, value: string): string | boolean {
  const normalizedName = optionName.toLowerCase();
  if (normalizedName === "optimizationlevel") {
    if (value === "true") return "Full";
    if (value === "false") return "None";
    return validateEnumValue(optionName, value, ["Full", "None"]);
  }

  if (booleanCompilerOptions.has(normalizedName)) {
    return value === "true"
      ? true
      : value === "false"
        ? false
        : invalidCompilerOptionValue(optionName, value);
  }

  const enumValues = enumCompilerOptions.get(normalizedName);
  return enumValues === undefined ? value : validateEnumValue(optionName, value, enumValues);
}

function validateEnumValue(
  optionName: string,
  value: string,
  enumValues: readonly string[],
): string {
  const canonicalValue = enumValues.find(
    (enumValue) => enumValue.toLowerCase() === value.toLowerCase(),
  );
  return canonicalValue ?? invalidCompilerOptionValue(optionName, value);
}

function invalidCompilerOptionValue(optionName: string, value: string): never {
  throw new Error(`Invalid value for StCompiler.${optionName}: ${value}`);
}

function isSharedBackendOption(optionName: string): boolean {
  return ["EnableRuntimeChecks", "StaticLinkIr"].includes(optionName);
}

const booleanCompilerOptions = new Set([
  "devirtualization",
  "useonecore",
  "warnifoutputnotassigned",
  "warningsaserrors",
  "additionalhints",
  "skipcodegeneration",
  "generateinstrumentationdata",
  "debug",
  "disableparallelization",
  "enableruntimechecks",
]);

const enumCompilerOptions = new Map<string, readonly string[]>([
  ["loggingverbosity", ["Trace", "Debug", "Information", "Warning", "Error", "Critical", "None"]],
  ["symbolinfoformat", ["Binary", "Json"]],
  ["outputformat", ["Text", "Binary"]],
]);

function appendCompilerOptionComments(
  yaml: string,
  resolvedOptions: readonly ResolvedCompilerOption[],
): string {
  const comments = new Map<string, string>();
  for (const option of resolvedOptions) {
    if (option.comment !== undefined && option.comment.trim().length > 0) {
      comments.set(option.name.toLowerCase(), option.comment);
    }
  }

  if (comments.size === 0) {
    return yaml;
  }

  const newline = yaml.includes("\r\n") ? "\r\n" : "\n";
  return yaml
    .split(/\r?\n/)
    .map((line) => {
      for (const [name, comment] of comments) {
        if (new RegExp(`^\\s+${escapeRegExp(name)}\\s*:`, "i").test(line)) {
          return `${line} ${comment}`;
        }
      }
      return line;
    })
    .join(newline);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}