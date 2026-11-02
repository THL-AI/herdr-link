#!/usr/bin/env node
// Installs (or with --uninstall removes) the shared agent hook for Claude Code
// (~/.claude/settings.json, backed up first) and Grok (~/.grok/hooks/herdr-link.json).
// Idempotent; leaves every other hook alone.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const uninstall = process.argv.includes("--uninstall")
const script = join(dirname(fileURLToPath(import.meta.url)), "herdr-link-hook.mjs")
const command = `node '${script}'`
const events = ["Stop", "StopFailure", "Notification"]
// Ours, including the name it had before the project was renamed.
const markers = ["herdr-link-hook.mjs", "herdr-bridge-hook.mjs"]
const entry = { hooks: [{ type: "command", command, timeout: 10 }] }

const withoutOurs = (groups = []) =>
  groups
    .map((group) => ({
      ...group,
      hooks: (group.hooks ?? []).filter((hook) => !markers.some((marker) => String(hook.command ?? "").includes(marker)))
    }))
    .filter((group) => group.hooks.length > 0)

// Claude Code
const claude = join(homedir(), ".claude", "settings.json")
if (existsSync(claude)) {
  const settings = JSON.parse(readFileSync(claude, "utf8"))
  const backup = `${claude}.before-herdr-link`
  if (!existsSync(backup)) copyFileSync(claude, backup) // keep the very first original
  settings.hooks ??= {}
  for (const event of events) {
    const groups = withoutOurs(settings.hooks[event])
    if (!uninstall) groups.push(entry)
    if (groups.length === 0) delete settings.hooks[event]
    else settings.hooks[event] = groups
  }
  writeFileSync(claude, `${JSON.stringify(settings, null, 2)}\n`)
  console.log(`${uninstall ? "removed from" : "installed in"} ${claude} (backup: settings.json.before-herdr-link)`)
}

// Grok
const grok = join(homedir(), ".grok", "hooks", "herdr-link.json")
rmSync(join(homedir(), ".grok", "hooks", "herdr-bridge.json"), { force: true }) // the old name
if (uninstall) {
  rmSync(grok, { force: true })
  console.log(`removed ${grok}`)
} else if (existsSync(join(homedir(), ".grok"))) {
  mkdirSync(dirname(grok), { recursive: true })
  writeFileSync(grok, `${JSON.stringify({ hooks: Object.fromEntries(events.map((e) => [e, [entry]])) }, null, 2)}\n`)
  console.log(`installed ${grok}`)
}
