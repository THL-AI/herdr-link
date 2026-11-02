#!/usr/bin/env node
// The built-in Telegram adapter, runnable from anywhere.
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { register } from "tsx/esm/api"

register()
await import(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "adapters", "telegram", "main.ts"))
