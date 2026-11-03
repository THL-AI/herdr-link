#!/usr/bin/env node
// The herdr-link command, runnable from anywhere (PATH, launchd, systemd),
// with secrets from ~/.config/herdr-link/.env (or a .env in a source checkout).
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { load, root } from "./load.mjs"

for (const env of [join(homedir(), ".config", "herdr-link", ".env"), join(root, ".env")]) {
  if (existsSync(env)) process.loadEnvFile(env)
}
await load("cli/main")
