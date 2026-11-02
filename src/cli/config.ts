/** Writes `config.toml` and `.env` for `herdr-link init`. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/** Agents herdr-link knows how to drive, with keys verified against their real prompts. */
const knownAgents: Record<string, string> = {
  claude: `[agents.claude]
template = "claude"
emoji = "✳️"
logo = "claude"        # an application emoji with this name, if you upload one
allow = ["1"]          # Claude Code: 1 = Yes
always = ["2"]         # 2 = Yes, and don't ask again
deny = ["esc"]         # esc = No; Claude then asks what to do instead`,
  grok: `[agents.grok]
template = "grok"
emoji = "⚪"
logo = "grok"
allow = ["3"]          # Grok Build: 3 = Yes, proceed
always = ["2"]         # 2 = always allow this command (never 1: global always-approve)
deny = ["4"]           # 4 = No, reject
trust = ["y"]          # "Do you trust this folder?"`
}

export const knownAgentNames = Object.keys(knownAgents)

export const renderConfig = (options: {
  owner: string
  guild: string
  agents: ReadonlyArray<string>
  shell: string
}) =>
  [
    `# herdr-link config. Secrets go in .env next to it, never here.

[adapters.discord]
command = ["herdr-link-discord"]
env = ["DISCORD_TOKEN"]
owner = "${options.owner}"   # your Discord user id: only you can drive the agents
guild = "${options.guild}"   # the server with your agents' channels`,
    ...options.agents.flatMap((name) => (knownAgents[name] === undefined ? [] : [knownAgents[name]])),
    `[agents.shell]
argv = ["${options.shell}", "-l"]
emoji = "🐚"`
  ].join("\n\n") + "\n"

/** Sets `KEY=value` in an env file, keeping its other lines; readable by the owner only. */
export const writeEnv = (file: string, key: string, value: string) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l !== "" && !l.startsWith(`${key}=`)) : []
  writeFileSync(file, `${[...lines, `${key}=${value}`].join("\n")}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

export const readEnv = (file: string, key: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1).trim()
    : undefined
