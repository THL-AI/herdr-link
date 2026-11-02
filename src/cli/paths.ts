/** Where herdr-link keeps things, and where it is installed. */
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const configDir = join(homedir(), ".config", "herdr-link")
export const configFile = process.env.HERDR_LINK_CONFIG || join(configDir, "config.toml")
export const envFile = join(configDir, ".env")
export const packageRoot = fileURLToPath(new URL("../..", import.meta.url))
export const binFile = join(packageRoot, "bin", "herdr-link.mjs")
export const hookFile = join(packageRoot, "hooks", "herdr-link-hook.mjs")
export const coreSocket = process.env.HC_TERMINAL_SOCKET || join(homedir(), ".local/state/herdr-core/default/default.sock")
