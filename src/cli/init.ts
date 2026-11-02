/** `herdr-link init`: from a bot token to a running bridge, asking only what it cannot find out. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { basename, dirname } from "node:path"
import * as Config from "./config.ts"
import * as Discord from "./discord.ts"
import * as Hooks from "./hooks.ts"
import { configFile, envFile } from "./paths.ts"
import * as Probe from "./probe.ts"
import { ask, bad, confirm, note, ok, secret } from "./prompt.ts"
import * as Service from "./service.ts"

const step = (title: string) => console.log(`\n${title}`)

const portalSteps = [
  "Create the bot at https://discord.com/developers/applications:",
  "  1. New Application. On Installation, set Install Link to None.",
  "  2. Bot: turn off Public Bot, turn on Message Content Intent, Reset Token and copy it.",
  "  (Optional: upload your agents' logos under Emojis, named claude and grok.)"
]

export const init = async () => {
  console.log("herdr-link setup: your herdr agents in Discord.")

  step("1. herdr")
  const core = await Probe.core()
  if (core.ok) ok(`herdr-core ${core.version}`)
  else {
    bad(`herdr-core is not reachable (${core.error})`)
    note("Start herdr first; the bridge waits for it, so you can still finish the setup.")
  }
  if (Probe.onPath("herdr-app")) ok("herdr-app")
  else note("herdr-app is not on PATH: new tabs from the chat and /space new will not work.")

  step("2. Discord bot")
  let token = process.env.DISCORD_TOKEN ?? Config.readEnv(envFile, "DISCORD_TOKEN")
  if (token !== undefined && !(await confirm("Use the bot token you already have?"))) token = undefined
  let app: Discord.Application | undefined
  let key = ""
  while (app === undefined) {
    if (token === undefined) for (const line of portalSteps) note(line)
    key = token ?? (await secret("  Bot token:"))
    try {
      app = await Discord.application(key)
      ok(`bot ${app.name}`)
    } catch (error) {
      bad(`that token does not work (${(error as Error).message})`)
      token = undefined
    }
  }

  while (!Discord.hasMessageContent(app)) {
    try {
      app = await Discord.enableMessageContent(key, app)
      ok("turned on the Message Content intent")
    } catch {
      bad("the Message Content intent is off: the bot cannot read your messages")
      note(`Turn it on: https://discord.com/developers/applications/${app.id}/bot`)
      await ask("  Press Enter when done.")
      app = await Discord.application(key)
    }
  }
  if (Discord.hasMessageContent(app)) ok("Message Content intent")
  if (app.bot_public) {
    bad("the bot is public: anyone could add it to their server")
    note(`Set Install Link to None, then turn off Public Bot: https://discord.com/developers/applications/${app.id}/installation`)
  }

  const found = Discord.owner(app)
  let owner = found?.id
  if (found === undefined || !(await confirm(`  Are you ${found.username}? Only you will be able to drive the agents.`))) {
    owner = await ask("  Your Discord user id (Settings → Advanced → Developer Mode, then right-click your name):")
  }

  let guild: { id: string; name: string } | undefined
  while (guild === undefined) {
    const list = await Discord.guilds(key)
    if (list.length === 0) {
      bad("the bot is not on any server yet")
      note("Invite it to your own server (a new private server is best):")
      note(Discord.inviteUrl(app.id))
      await ask("  Press Enter once it is there.")
      continue
    }
    if (list.length === 1) guild = list[0]
    else {
      list.forEach((g, i) => note(`${i + 1}. ${g.name}`))
      const pick = Number(await ask("  Which server?", "1"))
      guild = list[pick - 1]
    }
  }
  ok(`server ${guild.name}`)

  // Two bridges can't share one bot (both would answer the DM and commands), and their
  // categories would look the same: each computer gets its own bot and a name.
  let machine: string | undefined
  if (await confirm("  Do you run herdr-link on another computer with this server too?", false)) {
    machine = await ask("  Name of this computer, shown in its category names:", hostname().split(".")[0])
    note("Each computer needs its own bot: create another application for the other one.")
  }

  step("3. Agents")
  const agents = Config.knownAgentNames.filter((name) => Probe.onPath(name))
  const shell = basename(process.env.SHELL || "/bin/sh")
  ok(`${[...agents, "shell"].join(", ")}${agents.length === 0 ? " (no claude or grok on PATH)" : ""}`)

  step("4. Config")
  const write = !existsSync(configFile) || (await confirm(`  ${configFile} exists. Replace it?`, false))
  if (write) {
    mkdirSync(dirname(configFile), { recursive: true })
    writeFileSync(
      configFile,
      Config.renderConfig({ owner: owner!, guild: guild.id, agents, shell, ...(machine ? { machine } : {}) })
    )
    ok(configFile)
  } else note(`kept ${configFile} (check owner and guild in it)`)
  Config.writeEnv(envFile, "DISCORD_TOKEN", key)
  ok(`${envFile} (only you can read it)`)

  step("5. Agent hooks (their replies reach the chat through them)")
  if (await confirm("  Install them for Claude Code and Grok?")) {
    for (const line of Hooks.install()) ok(line)
    note("Restart running agent sessions to pick them up.")
  } else note("Later: herdr-link hooks install")

  step("6. Run it")
  let service: ReturnType<typeof Service.manager> | undefined
  try {
    service = Service.manager()
  } catch (error) {
    note((error as Error).message)
  }
  if (service !== undefined && (await confirm(`  Run it in the background (${service.name}), starting at login?`))) {
    for (const line of service.install()) ok(line)
  } else note("Run it yourself: herdr-link run")

  console.log(`
Done. In a minute your herdr spaces show up as private categories in ${guild.name}.
  • Write in a tab's channel to talk to its agent; DM the bot for the control room.
  • Server Settings → Integrations → ${app.name}: allow its commands only for yourself.
  • Right-click each category → Notification Settings → All Messages, for pushes.
  • Check everything any time: herdr-link doctor`)
}
