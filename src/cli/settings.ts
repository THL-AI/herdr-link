/**
 * Settings switched from the command line or the herdr-app mod:
 *
 * - `herdr-link desk on | off`: at the computer or away (`state.json`, read by
 *   the running bridge on every message; no restart).
 * - `herdr-link adapter <name> on | off` and `herdr-link adapter <name>
 *   dashboard on | off`: one line in the adapter's config section, the rest of
 *   the file (comments too) kept as it is; then the service restarts.
 * - `herdr-link status [--json]`: what `status.json` says.
 */
import { Effect } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import * as LocalState from "../bridge/LocalState.ts"
import * as Config from "../Config.ts"
import { configFile } from "./paths.ts"
import { bad, note, ok } from "./prompt.ts"
import * as Service from "./service.ts"

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Sets `key = value` in the `[adapters.<name>]` section of a TOML text: the
 * key's line is replaced, or added right under the section header.
 */
export const setAdapterKey = (text: string, adapter: string, key: string, value: boolean): string => {
  const lines = text.split("\n")
  const header = new RegExp(`^\\s*\\[\\s*adapters\\.${escape(adapter)}\\s*\\]\\s*(#.*)?$`)
  const start = lines.findIndex((line) => header.test(line))
  if (start === -1) throw new Error(`no [adapters.${adapter}] section in the config`)
  let end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line))
  if (end === -1) end = lines.length
  const keyLine = new RegExp(`^\\s*${escape(key)}\\s*=`)
  const at = lines.findIndex((line, index) => index > start && index < end && keyLine.test(line))
  const line = `${key} = ${value}`
  if (at === -1) lines.splice(start + 1, 0, line)
  else lines[at] = line
  return lines.join("\n")
}

const onOff = (word: string | undefined) => (word === "on" ? true : word === "off" ? false : undefined)

/** Restarts the service when it runs, so the bridge reads the new config. */
const restart = () => {
  const service = Service.manager()
  if (!service.status().running) {
    note("herdr-link isn't running as a service: restart it yourself to apply this")
    return
  }
  for (const line of service.restart()) ok(line)
}

export const adapter = (args: ReadonlyArray<string | undefined>) => {
  const [name, first, second] = args
  const key = first === "dashboard" ? "dashboard" : "enabled"
  const value = onOff(first === "dashboard" ? second : first)
  if (name === undefined || value === undefined) {
    bad("usage: herdr-link adapter <name> on | off, or herdr-link adapter <name> dashboard on | off")
    return 1
  }
  const before = readFileSync(configFile, "utf8")
  const after = setAdapterKey(before, name, key, value)
  // Never leave a config the bridge can't load.
  const problem = Effect.runSync(
    Effect.match(Config.parse(after, configFile), { onFailure: (error) => error.message, onSuccess: () => undefined })
  )
  if (problem !== undefined) {
    bad(`not changed: the config would not load: ${problem}`)
    return 1
  }
  if (after !== before) writeFileSync(configFile, after)
  ok(`${name}: ${key} = ${value}`)
  restart()
  return 0
}

export const desk = (word: string | undefined) => {
  if (word !== undefined) {
    const on = onOff(word)
    if (on === undefined) {
      bad("usage: herdr-link desk [on | off]")
      return 1
    }
    LocalState.setDesk(on)
  }
  ok(LocalState.atDesk() ? "at the desk: messages arrive without a push" : "away: messages arrive with a push")
  return 0
}

export const status = (json: boolean) => {
  const status = LocalState.readStatus()
  const alive = LocalState.isAlive(status)
  if (json) {
    console.log(JSON.stringify({ alive, desk: LocalState.atDesk(), status: status ?? null }, null, 2))
    return alive ? 0 : 1
  }
  if (status === undefined) {
    bad("herdr-link hasn't run yet (no status.json)")
    return 1
  }
  if (!alive) bad(status.running ? `not answering since ${status.updated}` : `stopped at ${status.updated}`)
  else ok(`running ${status.version}, pid ${status.pid}, since ${status.started}`)
  for (const a of status.adapters) {
    const state = !a.enabled ? "off" : a.connected ? "connected" : a.error === undefined ? "connecting" : a.error
    ;(a.enabled && !a.connected ? bad : ok)(`${a.name}: ${state}${a.enabled && !a.dashboard ? " (no dashboard)" : ""}`)
  }
  for (const [agent, hook] of Object.entries(status.hooks)) {
    if (hook !== "absent") (hook === "ok" ? ok : bad)(`${agent} hook: ${hook}`)
  }
  ok(LocalState.atDesk() ? "at the desk (no pushes)" : "away (pushes on)")
  return alive ? 0 : 1
}
