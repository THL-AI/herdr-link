/**
 * Installs the shared agent hook for Claude Code (`~/.claude/settings.json`,
 * backed up once) and Grok (`~/.grok/hooks/herdr-link.json`). Idempotent;
 * other hooks are left alone.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { hookFile } from "./paths.ts"

const events = ["Stop", "StopFailure", "Notification"] as const
/** Ours, including the name it had before the project was renamed. */
const markers = ["herdr-link-hook.mjs", "herdr-bridge-hook.mjs"]
const claudeSettings = join(homedir(), ".claude", "settings.json")
const grokDir = join(homedir(), ".grok")
const grokHooks = join(grokDir, "hooks", "herdr-link.json")

interface Hook {
  readonly type?: string
  readonly command?: string
}
interface Group {
  readonly hooks?: ReadonlyArray<Hook>
}

const isOurs = (hook: Hook) => markers.some((marker) => String(hook.command ?? "").includes(marker))
const entry = () => ({ hooks: [{ type: "command", command: `node '${hookFile}'`, timeout: 10 }] })

const withoutOurs = (groups: ReadonlyArray<Group> = []) =>
  groups.map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook)) }))
    .filter((group) => group.hooks.length > 0)

export const install = (remove = false): Array<string> => {
  const done: Array<string> = []
  if (existsSync(claudeSettings)) {
    const settings = JSON.parse(readFileSync(claudeSettings, "utf8"))
    const backup = `${claudeSettings}.before-herdr-link`
    if (!existsSync(backup)) copyFileSync(claudeSettings, backup)
    settings.hooks ??= {}
    for (const event of events) {
      const groups: Array<unknown> = withoutOurs(settings.hooks[event])
      if (!remove) groups.push(entry())
      if (groups.length === 0) delete settings.hooks[event]
      else settings.hooks[event] = groups
    }
    writeFileSync(claudeSettings, `${JSON.stringify(settings, null, 2)}\n`)
    done.push(`Claude Code: ${claudeSettings} (backup: settings.json.before-herdr-link)`)
  }
  rmSync(join(grokDir, "hooks", "herdr-bridge.json"), { force: true }) // the old name
  if (remove) {
    rmSync(grokHooks, { force: true })
    done.push(`Grok: removed ${grokHooks}`)
  } else if (existsSync(grokDir)) {
    mkdirSync(dirname(grokHooks), { recursive: true })
    writeFileSync(grokHooks, `${JSON.stringify({ hooks: Object.fromEntries(events.map((e) => [e, [entry()]])) }, null, 2)}\n`)
    done.push(`Grok: ${grokHooks}`)
  }
  return done
}

/** Which agents have the hook, pointing at this install. */
export const status = () => {
  const claude = existsSync(claudeSettings)
    ? (() => {
      const settings = JSON.parse(readFileSync(claudeSettings, "utf8"))
      const commands = events.flatMap((event) =>
        ((settings.hooks?.[event] ?? []) as ReadonlyArray<Group>).flatMap((g) => g.hooks ?? []).filter(isOurs)
      ).map((hook) => String(hook.command))
      return commands.length === 0 ? "missing" : commands.every((c) => c.includes(hookFile)) ? "ok" : "stale"
    })()
    : "absent"
  const grok = !existsSync(grokDir)
    ? "absent"
    : !existsSync(grokHooks)
    ? "missing"
    : readFileSync(grokHooks, "utf8").includes(hookFile)
    ? "ok"
    : "stale"
  return { claude, grok } as const
}
