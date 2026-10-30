export interface ResolvedCompilerOption {
  readonly name: string;
  readonly value: string;
  readonly comment: string | undefined;
}

const listOptionNames = new Set([
  "inputdirectories",
  "libraries",
  "enableprototypefeatures",
  "directives",
  "staticlinkir",
]);

const optionNames = new Map<string, string>([
  ["--input", "InputDirectories"],
  ["-i", "InputDirectories"],
  ["--lib", "Libraries"],
  ["--enable-feature", "EnablePrototypeFeatures"],
  ["--output", "OutputDirectory"],
  ["-o", "OutputDirectory"],
  ["-fdevirtualization", "Devirtualization"],
  ["--1core", "UseOneCore"],
  ["-1", "UseOneCore"],
  ["--write-statistics-to", "WriteStatisticsTo"],
  ["--object-dir", "IntermediateFileOutputDirectory"],
  ["--log", "LoggingVerbosity"],
  ["-l", "LoggingVerbosity"],
  ["-fwarn-output-not-assigned", "WarnIfOutputNotAssigned"],
  ["-fwarnings-as-errors", "WarningsAsErrors"],
  ["-fhints", "AdditionalHints"],
  ["-fskip-code-gen", "SkipCodeGeneration"],
  ["-fprofile", "GenerateInstrumentationData"],
  ["--self-profile", "SelfProfile"],
  ["--sym-format", "SymbolInfoFormat"],
  ["--debug", "Debug"],
  ["-d", "Debug"],
  ["--Optimize", "OptimizationLevel"],
  ["--optimize", "OptimizationLevel"],
  ["-O", "OptimizationLevel"],
  ["--format", "OutputFormat"],
  ["-f", "OutputFormat"],
  ["--native-target", "LlvmTarget"],
  ["--generate-runtime-checks", "EnableRuntimeChecks"],
  ["--static-link-ir", "StaticLinkIr"],
  ["--disable-parallelization", "DisableParallelization"],
  ["--directive", "Directives"],
]);

export function resolveCompilerOptions(
  buildArguments: Iterable<string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const option of resolveCompilerOptionsWithComments(buildArguments)) {
    resolved[option.name] = option.value;
  }
  return resolved;
}

export function resolveCompilerOptionsWithComments(
  buildArguments: Iterable<string>,
): readonly ResolvedCompilerOption[] {
  const resolved: ResolvedCompilerOption[] = [];
  for (const argument of buildArguments) {
    if (argument.trim().length === 0) {
      continue;
    }

    const { optionText, comment } = splitComment(argument);
    const tokens = tokenize(optionText);
    const firstToken = tokens[0];
    if (firstToken === undefined) {
      continue;
    }

    const { optionName, inlineValue } = splitOption(firstToken);
    const makeOptionName = optionNames.get(optionName);
    if (makeOptionName === undefined) {
      continue;
    }

    let value = inlineValue;
    if (value === undefined && hasValueToken(tokens, 1)) {
      value = tokens[1];
    }

    const resolvedOption: ResolvedCompilerOption = {
      name: makeOptionName,
      value: value ?? "true",
      comment,
    };
    if (isRepeatableCompilerOption(makeOptionName)) {
      resolved.push(resolvedOption);
      continue;
    }

    const normalizedName = normalizeOptionName(makeOptionName);
    for (let index = resolved.length - 1; index >= 0; index--) {
      if (normalizeOptionName(resolved[index]?.name ?? "") === normalizedName) {
        resolved.splice(index, 1);
      }
    }
    resolved.push(resolvedOption);
  }

  return resolved;
}

export function isListCompilerOption(optionName: string): boolean {
  return listOptionNames.has(normalizeOptionName(optionName));
}

function isRepeatableCompilerOption(optionName: string): boolean {
  return isListCompilerOption(optionName) || normalizeOptionName(optionName) === "llvmtarget";
}

export function getCompilerOptionInlineComment(argument: string): string | undefined {
  return splitComment(argument).comment;
}

function tokenize(buildArgument: string): string[] {
  return [...buildArgument.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((match) =>
    unquote(match[0]),
  );
}

function splitComment(argument: string): {
  optionText: string;
  comment: string | undefined;
} {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < argument.length; index++) {
    const current = argument[index];
    if ((current === '"' || current === "'") && (quote === undefined || quote === current)) {
      quote = quote === undefined ? current : undefined;
      continue;
    }

    if (current === "#" && quote === undefined) {
      return {
        optionText: argument.slice(0, index).trimEnd(),
        comment: argument.slice(index).trim(),
      };
    }
  }

  return { optionText: argument, comment: undefined };
}

function splitOption(token: string): {
  optionName: string;
  inlineValue: string | undefined;
} {
  const separatorIndex = token.indexOf("=");
  return separatorIndex > 0
    ? {
        optionName: token.slice(0, separatorIndex),
        inlineValue: token.slice(separatorIndex + 1),
      }
    : { optionName: token, inlineValue: undefined };
}

function hasValueToken(tokens: readonly string[], index: number): boolean {
  const token = tokens[index];
  return token !== undefined && (token.length === 0 || token[0] !== "-");
}

function unquote(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1)
    : value;
}

function normalizeOptionName(optionName: string): string {
  return optionName.toLowerCase();
}