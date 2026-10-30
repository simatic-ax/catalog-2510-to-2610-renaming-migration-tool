#!/usr/bin/env node

import { runCli } from "./cli.js";

export async function runContributedMigrate(arguments_: readonly string[]): Promise<number> {
  return runCli(["migrate", ...arguments_]);
}

process.exitCode = await runContributedMigrate(process.argv.slice(2));