import { spawn } from "node:child_process";

export interface ApaxCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type ApaxCommandRunner = (
  arguments_: readonly string[],
  workingDirectory: string,
) => Promise<ApaxCommandResult>;

export const runApaxCommand: ApaxCommandRunner = async (arguments_, workingDirectory) =>
  new Promise((resolve, reject) => {
    const executable = process.platform === "win32" ? "apax.cmd" : "apax";
    const child = spawn(executable, arguments_, {
      cwd: workingDirectory,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => stdout += chunk.toString());
    child.stderr.on("data", (chunk: Buffer) => stderr += chunk.toString());
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stderr, stdout }));
  });
