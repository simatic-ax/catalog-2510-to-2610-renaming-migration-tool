import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { CliExitCode } from "../src/domain/cli-exit-codes.js";

const packageVersion = (JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string }).version;

vi.mock("../src/io/apax-command-runner.js", () => ({
  runApaxCommand: vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" }),
}));

vi.mock("../src/migration/catalog-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/migration/catalog-resolver.js")>();
  return {
    ...actual,
    acquireCatalog: async (
      _source: unknown,
      options: { name: string; version: string },
    ) => ({
      dependencies: {},
      name: options.name,
      version: options.version === "latest" ? "2610.0.0-test" : options.version,
    }),
  };
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runCli", () => {
  it.each([
    { arguments_: [] },
    { arguments_: ["-h"] },
    { arguments_: ["--help"] },
  ])("prints general help to stdout for $arguments_", async ({ arguments_ }) => {
    const result = await invoke(arguments_);

    expect(result.code).toBe(CliExitCode.Success);
    expect(result.stdout).toContain("MigrateTool");
    expect(result.stdout).toContain("migrate-tool migrate");
    expect(result.stderr).toBe("");
  });

  it.each([
    { arguments_: ["migrate", "-h"] },
    { arguments_: ["migrate", "--help"] },
  ])(
    "prints migrate help to stdout for $arguments_",
    async ({ arguments_ }) => {
      const result = await invoke(arguments_);

      expect(result.code).toBe(CliExitCode.Success);
      expect(result.stdout).toContain("-o,--output <path>");
      expect(result.stdout).toContain("-m,--mode <mode>");
      expect(result.stdout).toContain("-s,--skipsave");
      expect(result.stdout).toContain("--accept-all-prompts");
      expect(result.stdout).toContain("--catalog <catalog>");
      expect(result.stdout).toContain("--exact");
      expect(result.stdout).toContain("--tilde");
      expect(result.stdout).toContain("--caret");
      expect(result.stdout).not.toContain("#0");
      expect(result.stderr).toBe("");
    },
  );

  it.each([
    { arguments_: ["-v"] },
    { arguments_: ["--version"] },
    { arguments_: ["migrate", "-v"] },
    { arguments_: ["migrate", "--version"] },
  ])("prints package version to stdout for $arguments_", async ({ arguments_ }) => {
    const result = await invoke(arguments_);

    expect(result.code).toBe(CliExitCode.Success);
    expect(result.stdout.trim()).toBe(packageVersion);
    expect(result.stderr).toBe("");
  });

  it.each([
    { arguments_: ["unknown"] },
    { arguments_: ["migrate", "--unknown"] },
    { arguments_: ["migrate", "--output"] },
  ])("returns usage and logs parse errors to stderr for $arguments_", async ({ arguments_ }) => {
    const result = await invoke(arguments_);

    expect(result.code).toBe(CliExitCode.Usage);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error");
    expect(result.stderr).toContain("Use --help to see available options and commands.");
  });

  it.each([
    ["--exact", "--tilde"],
    ["--exact", "--caret"],
    ["--tilde", "--caret"],
  ])("rejects multiple catalog compatibility options: %s %s", async (first, second) => {
    const result = await invoke(["migrate", first, second]);

    expect(result.code).toBe(CliExitCode.Usage);
    expect(result.stderr).toContain("Only one catalog compatibility option may be used");
  });

  it("rejects an unsafe catalog version", async () => {
    const result = await invoke(["migrate", "--catalog", "latest;echo-bad"]);

    expect(result.code).toBe(CliExitCode.Usage);
    expect(result.stderr).toContain("Invalid catalog");
  });

  it("writes migration validation messages to stderr", async () => {
    const directory = mkdtempSync(join(tmpdir(), "migrate-cli-test-"));
    temporaryDirectories.push(directory);

    const result = await invoke(["migrate"], directory);

    expect(result.code).toBe(CliExitCode.Validation);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Could not find apax.yml at ${join(directory, "apax.yml")}`);
  });

  it("accepts an interactive answer without waiting for stdin to end", async () => {
    const directory = mkdtempSync(join(tmpdir(), "migrate-cli-test-"));
    temporaryDirectories.push(directory);
    mkdirSync(join(directory, "src"));
    mkdirSync(join(directory, "migrated_project"));
    writeFileSync(join(directory, "apax.yml"), [
      "type: lib",
      "targets:",
      "  - 1500",
      "catalogs:",
      "  \"@ax/simatic-ax\": \"^2510.0.0\"",
      "dependencies: {}",
      "devDependencies: {}",
    ].join("\n"));
    writeFileSync(join(directory, "src", "Main.st"), "PROGRAM Main\nEND_PROGRAM");
    writeFileSync(join(directory, "migrated_project", "stale.txt"), "stale");

    const invocation = invoke(["migrate"], directory, "yes\n", false);
    await expect(invocation).resolves.toMatchObject({ code: CliExitCode.Success });
  });

  it("migrates only the current app when it is inside a workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "migrate-cli-workspace-test-"));
    temporaryDirectories.push(workspace);
    writeFileSync(join(workspace, "apax.yml"), "type: workspace\n");
    const currentProject = join(workspace, "alpha");
    const siblingProject = join(workspace, "beta");
    for (const project of [currentProject, siblingProject]) {
      mkdirSync(join(project, "src"), { recursive: true });
      writeFileSync(join(project, "apax.yml"), [
        "type: app",
        "targets: [s7]",
        "catalogs:",
        '  "@ax/simatic-ax": "^2510.0.0"',
      ].join("\n"));
      writeFileSync(join(project, "src", "Main.st"), "PROGRAM Main\nEND_PROGRAM");
    }

    const result = await invoke(["migrate"], currentProject, "\n", false);

    expect(result.code).toBe(CliExitCode.Success);
    expect(result.stderr).not.toContain("Workspace detected:");
    expect(existsSync(join(currentProject, "migrated_project", "apax.yml"))).toBe(true);
    expect(existsSync(join(siblingProject, "migrated_project"))).toBe(false);
  });
});

async function invoke(
  arguments_: readonly string[],
  currentDirectory?: string,
  input = "",
  endInput = true,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutText = "";
  let stderrText = "";
  stdout.on("data", (chunk: Buffer) => stdoutText += chunk.toString());
  stderr.on("data", (chunk: Buffer) => stderrText += chunk.toString());
  if (input.length > 0) stdin.write(input);
  if (endInput) stdin.end();

  const code = await runCli(
    arguments_,
    { stdin, stdout, stderr },
    currentDirectory === undefined ? undefined : () => currentDirectory,
  );
  return { code, stdout: stdoutText, stderr: stderrText };
}