#!/usr/bin/env node
// The bridge, runnable from anywhere (launchd, PATH): loads TypeScript through
// tsx resolved next to this file, and secrets from ~/.config/herdr-link/.env
// or the repo's .env.
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { register } from "tsx/esm/api"

const repo = join(dirname(fileURLToPath(import.meta.url)), "..")
for (const env of [join(homedir(), ".config", "herdr-link", ".env"), join(repo, ".env")]) {
  if (existsSync(env)) process.loadEnvFile(env)
}
register()
await import(join(repo, "src", "main.ts"))
