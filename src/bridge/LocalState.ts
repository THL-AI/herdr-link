/**
 * Files in herdr-link's state folder (`~/.local/state/herdr-link`, beside the
 * hook socket) that other programs share with the bridge:
 *
 * - `state.json`: what the owner switches while it runs, written by
 *   `herdr-link desk` or the herdr-app mod: `{"desk": true}` while they sit
 *   at the computer (new messages then go out without a push).
 * - `status.json`: what the bridge is doing, rewritten on every change and at
 *   least every 30 s while it runs, `running: false` when it stops. The mod and
 *   `herdr-link status` read it; an old `updated` means the bridge hangs or died.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const stateDir = () => process.env.HERDR_LINK_STATE || join(homedir(), ".local", "state", "herdr-link")

/** A status older than this means the bridge stopped answering. */
export const staleAfterMs = 90_000

export interface AdapterStatus {
  readonly name: string
  /** false: `enabled = false` in its section, not started. */
  readonly enabled: boolean
  /** false: no live status in the direct conversation. */
  readonly dashboard: boolean
  readonly connected: boolean
  readonly error?: string
}

export interface Status {
  readonly running: boolean
  readonly pid: number
  readonly version: string
  readonly config: string
  /** ISO times. */
  readonly started: string
  readonly updated: string
  readonly desk: boolean
  readonly adapters: ReadonlyArray<AdapterStatus>
  /** Per agent: "ok", "stale", "missing" or "absent" (the agent isn't installed). */
  readonly hooks: Readonly<Record<string, string>>
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

/** Written whole and renamed into place, so readers never see half a file. */
const writeJson = (dir: string, name: string, value: unknown) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temporary = join(dir, `.${name}.${process.pid}`)
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, join(dir, name))
}

/** Whether the owner said they are at the computer. Read on every use: the file is tiny. */
export const atDesk = (dir = stateDir()) => {
  const state = readJson(join(dir, "state.json"))
  return typeof state === "object" && state !== null && (state as { desk?: unknown }).desk === true
}

export const setDesk = (on: boolean, dir = stateDir()) => {
  const state = readJson(join(dir, "state.json"))
  writeJson(dir, "state.json", { ...(typeof state === "object" && state !== null ? state : {}), desk: on })
}

export const writeStatus = (status: Status, dir = stateDir()) => writeJson(dir, "status.json", status)

export const readStatus = (dir = stateDir()): Status | undefined => {
  const path = join(dir, "status.json")
  return existsSync(path) ? readJson(path) as Status | undefined : undefined
}

/** Running, and heard from lately. */
export const isAlive = (status: Status | undefined, now = Date.now()) =>
  status !== undefined && status.running && now - Date.parse(status.updated) < staleAfterMs
