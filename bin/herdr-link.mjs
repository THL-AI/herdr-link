#!/usr/bin/env node
// The herdr-link command, runnable from anywhere (PATH, launchd, systemd):
// loads TypeScript through tsx resolved next to this file, and secrets from
// ~/.config/herdr-link/.env (or a .env in a source checkout).
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { register } from "tsx/esm/api"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
for (const env of [join(homedir(), ".config", "herdr-link", ".env"), join(root, ".env")]) {
  if (existsSync(env)) process.loadEnvFile(env)
}
register()
await import(join(root, "src", "cli", "main.ts"))
