/**
 * `herdr-link mod install | uninstall`: the herdr-app mod (a small bar in its
 * own window, kept where it is dropped: is the link up, at the desk or away,
 * and a panel with the basic settings). Shipped layouts can't take new
 * blocks, so it is a kept window rather than a docked panel. Copied from
 * `mod/herdr-link/` into herdr-app's mods folder, with `link.js` saying where
 * node, this install and the state folder are, so it works whatever PATH the
 * app has.
 */
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { stateDir } from "../bridge/LocalState.ts"
import { binFile, packageRoot } from "./paths.ts"
import { bad, note, ok } from "./prompt.ts"

/** Asks the running Herdr window; undefined when there is none (or no herdr-app on PATH). */
const herdrApp = (...args: Array<string>) => {
  try {
    return execFileSync("herdr-app", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch {
    return undefined
  }
}

/** Whether the bar is open in the window (its overlay key is the mod's name). */
const isOpen = () => {
  const status = herdrApp("status")
  try {
    return status !== undefined && (JSON.parse(status).overlays as Array<string>).includes(name)
  } catch {
    return false
  }
}

const appHome = () => process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app")
const name = "herdr-link"

export const linkJs = (paths: { node: string; bin: string; state: string }) =>
  `// Written by \`herdr-link mod install\`: where this herdr-link is.\nexport const link = ${JSON.stringify(paths, null, 2)};\n`

export const install = () => {
  const home = appHome()
  if (!existsSync(home)) {
    bad(`no herdr-app here (${home}): install the Herdr app first`)
    return 1
  }
  const target = join(home, "mods", name)
  cpSync(join(packageRoot, "mod", name), target, { recursive: true })
  writeFileSync(join(target, "link.js"), linkJs({ node: process.execPath, bin: binFile, state: stateDir() }))
  ok(`mod: ${target}`)
  try {
    execFileSync("herdr-app", ["check", target], { stdio: ["ignore", "pipe", "pipe"] })
    ok("herdr-app check passed")
  } catch (error) {
    const e = error as { code?: string; stdout?: Buffer; stderr?: Buffer }
    if (e.code === "ENOENT") note("herdr-app isn't on PATH: open Herdr to load the mod")
    else {
      bad(`herdr-app check failed: ${`${e.stdout ?? ""}${e.stderr ?? ""}`.trim()}`)
      return 1
    }
  }
  // `mod.open` toggles: open it only when it isn't already.
  if (isOpen() || herdrApp("do", "mod.open", JSON.stringify({ name })) !== undefined) {
    ok("shown in the Herdr window: drag it where you like (it stays there), click it for the settings")
  } else note("open Herdr, then: command palette (⌘⇧P) → herdr-link")
  return 0
}

export const uninstall = () => {
  const target = join(appHome(), "mods", name)
  if (isOpen()) herdrApp("do", "mod.open", JSON.stringify({ name })) // closes it
  rmSync(target, { recursive: true, force: true })
  ok(`removed ${target}`)
  return 0
}
