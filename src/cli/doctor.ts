/** `herdr-link doctor`: checks every piece and says how to fix what is broken. */
import { Effect } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { connect } from "node:net"
import * as Hooks from "../bridge/Hooks.ts"
import * as BridgeConfig from "../Config.ts"
import * as Config from "./config.ts"
import * as Discord from "./discord.ts"
import * as HookInstall from "./hooks.ts"
import { configFile, envFile } from "./paths.ts"
import * as Probe from "./probe.ts"
import { bad, note, ok } from "./prompt.ts"
import * as Service from "./service.ts"

const answers = (path: string) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(path)
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })

export const doctor = async () => {
  let failures = 0
  const fail = (text: string, fix?: string) => {
    failures++
    bad(text)
    if (fix !== undefined) note(fix)
  }

  console.log("herdr")
  const core = await Probe.core()
  if (core.ok) ok(`herdr-core ${core.version}`)
  else fail(`herdr-core: ${core.error}`, "Start herdr.")
  if (Probe.onPath("herdr-app")) ok("herdr-app")
  else fail("herdr-app is not on PATH", "New tabs from the chat and /space new need it.")

  console.log("config")
  if (!existsSync(configFile)) {
    fail(`no ${configFile}`, "Run: herdr-link init")
    return failures
  }
  const parsed = await Effect.runPromise(
    BridgeConfig.parse(readFileSync(configFile, "utf8"), configFile).pipe(Effect.result)
  )
  if (parsed._tag === "Failure") {
    fail(`${configFile}: ${parsed.failure.message}`)
    return failures
  }
  const config = parsed.success
  ok(configFile)
  if (config.machine !== undefined) ok(`this computer is "${config.machine}" (in category names)`)
  for (const [name, agent] of Object.entries(config.agents ?? {})) {
    const program = agent.argv?.[0] ?? agent.template ?? name
    if (Probe.onPath(program)) ok(`agent ${name} (${program})`)
    else note(`agent ${name}: ${program} is not on PATH (fine if you don't use it)`)
  }

  const discord = config.adapters.discord
  if (discord !== undefined) {
    console.log("discord")
    const token = process.env.DISCORD_TOKEN ?? Config.readEnv(envFile, "DISCORD_TOKEN")
    if (token === undefined) fail("no DISCORD_TOKEN", `Put it in ${envFile}, or run: herdr-link init`)
    else {
      try {
        const app = await Discord.application(token)
        ok(`bot ${app.name}`)
        if (Discord.hasMessageContent(app)) ok("Message Content intent")
        else fail("Message Content intent is off", `https://discord.com/developers/applications/${app.id}/bot`)
        if (app.bot_public) {
          fail("the bot is public", `Install Link: None, then Public Bot off: https://discord.com/developers/applications/${app.id}/installation`)
        }
        const guilds = await Discord.guilds(token)
        const guild = guilds.find((g) => g.id === discord.guild)
        if (guild !== undefined) ok(`on server ${guild.name}`)
        else fail(`the bot is not on server ${String(discord.guild)}`, `Invite it: ${Discord.inviteUrl(app.id)}`)
        const owner = Discord.owner(app)
        if (owner !== undefined && owner.id !== discord.owner) {
          note(`owner in the config (${String(discord.owner)}) is not the app's owner (${owner.username}); fine if intended`)
        }
      } catch (error) {
        fail(`the token does not work: ${(error as Error).message}`, "Run: herdr-link init")
      }
    }
  }

  console.log("agent hooks")
  const hooks = HookInstall.status()
  for (const [agent, state] of Object.entries(hooks)) {
    if (state === "ok") ok(agent)
    else if (state === "absent") note(`${agent}: not installed on this machine`)
    else fail(`${agent}: hook ${state}`, "Run: herdr-link hooks install (then restart the agents)")
  }

  console.log("bridge")
  try {
    const service = Service.manager()
    const state = service.status()
    if (state.running) ok(`${service.name}: ${state.details}`)
    else if (state.installed) fail(`${service.name}: ${state.details}`, "See: herdr-link service logs")
    else note(`${service.name}: not installed (herdr-link service install), fine if you run it yourself`)
  } catch (error) {
    note((error as Error).message)
  }
  if (await answers(Hooks.defaultSocket())) ok("running and listening for hooks")
  else fail("not running", "Start it: herdr-link service install, or herdr-link run")

  console.log(failures === 0 ? "\nAll good." : `\n${failures} problem${failures === 1 ? "" : "s"}.`)
  return failures
}
