/**
 * `herdr-link doctor [--fix] [--yes]`: checks every piece herdr-link needs and
 * says how to fix what is broken. With `--fix` it fixes what it safely can:
 * hooks, the service, the Message Content intent, a stopped herdr-core, and,
 * after asking (or with `--yes`), installing herdr through its official script.
 */
import { Effect } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { connect } from "node:net"
import * as Hooks from "../bridge/Hooks.ts"
import { builtIn } from "../chat/AdapterProcess.ts"
import * as BridgeConfig from "../Config.ts"
import * as Config from "./config.ts"
import * as Discord from "./discord.ts"
import * as HookInstall from "./hooks.ts"
import { init } from "./init.ts"
import { configFile, envFile } from "./paths.ts"
import * as Probe from "./probe.ts"
import { bad, confirm, note, ok } from "./prompt.ts"
import * as Service from "./service.ts"

const { coreInstall, appInstall, shell } = Probe
const minimumNode = 24

interface Fix {
  readonly label: string
  /** Downloads or installs software: asks first, unless --yes. */
  readonly ask?: boolean
  readonly run: () => Promise<void>
}

type Status = "ok" | "warn" | "fail"

interface Finding {
  readonly status: Status
  readonly text: string
  readonly hint?: string
  readonly fix?: Fix
}

interface Group {
  readonly title: string
  readonly findings: ReadonlyArray<Finding>
}

const okay = (text: string): Finding => ({ status: "ok", text })
const warn = (text: string, hint?: string, fix?: Fix): Finding => ({
  status: "warn",
  text,
  ...(hint === undefined ? {} : { hint }),
  ...(fix === undefined ? {} : { fix })
})
const fail = (text: string, hint?: string, fix?: Fix): Finding => ({
  status: "fail",
  text,
  ...(hint === undefined ? {} : { hint }),
  ...(fix === undefined ? {} : { fix })
})

const answers = (path: string) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(path)
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })

const startCore: Fix = {
  label: "start herdr-core (hc server start)",
  run: async () => Probe.startCore()
}

const runInit: Fix = { label: "set it up (herdr-link init)", run: () => init() }

const installHooks: Fix = {
  label: "install the agent hooks",
  run: async () => {
    for (const line of HookInstall.install()) ok(line)
    note("Restart running agent sessions to pick them up.")
  }
}

const checkSystem = async (): Promise<Group> => {
  const findings: Array<Finding> = []
  const node = Number(process.versions.node.split(".")[0])
  findings.push(
    node >= minimumNode
      ? okay(`Node ${process.versions.node}`)
      : fail(`Node ${process.versions.node}; herdr-link needs ${minimumNode} or newer`, "Install a newer Node, then herdr-link again.")
  )
  if (!["darwin", "linux"].includes(process.platform)) {
    findings.push(warn(`${process.platform}: the background service only works on macOS and Linux`, "Run: herdr-link run"))
  }

  const core = await Probe.core()
  if (core.ok) findings.push(okay(`herdr-core ${core.version}`))
  else if (Probe.onPath("hc")) findings.push(fail("herdr-core is installed but not running", core.error, startCore))
  else {
    findings.push(fail("herdr-core is not installed", `Install it: ${coreInstall}`, {
      label: `install herdr-core (${coreInstall})`,
      ask: true,
      run: async () => {
        shell(coreInstall)
        note("If `hc` is not found afterwards, open a new terminal so PATH picks it up.")
      }
    }))
  }

  if (Probe.onPath("herdr-app")) findings.push(okay("herdr-app"))
  else {
    findings.push(warn(
      "herdr-app is not installed: new tabs from the chat and /space new need it",
      `Install it: ${appInstall}`,
      { label: `install the herdr app (${appInstall})`, ask: true, run: async () => shell(appInstall) }
    ))
  }
  return { title: "system", findings }
}

/** The config, if it reads; with the findings about it. */
const checkConfig = async () => {
  if (!existsSync(configFile)) {
    return { config: undefined, group: { title: "config", findings: [fail(`no ${configFile}`, "Run: herdr-link init", runInit)] } }
  }
  const parsed = await Effect.runPromise(
    BridgeConfig.parse(readFileSync(configFile, "utf8"), configFile).pipe(Effect.result)
  )
  if (parsed._tag === "Failure") {
    return {
      config: undefined,
      group: { title: "config", findings: [fail(`${configFile}: ${parsed.failure.message}`, "Fix it, or run herdr-link init to write a new one.")] }
    }
  }
  const config = parsed.success
  const findings: Array<Finding> = [okay(configFile)]
  if (config.machine !== undefined) findings.push(okay(`this computer is "${config.machine}" (in room names)`))
  for (const [name, agent] of Object.entries(config.agents ?? {})) {
    const program = agent.argv?.[0] ?? agent.template ?? name
    findings.push(
      Probe.onPath(program) ? okay(`agent ${name} (${program})`) : warn(`agent ${name}: ${program} is not on PATH`, "Fine if you don't use it.")
    )
  }
  return { config, group: { title: "config", findings } }
}

const checkDiscord = async (section: BridgeConfig.AdapterSection): Promise<Array<Finding>> => {
  const token = process.env.DISCORD_TOKEN ?? Config.readEnv(envFile, "DISCORD_TOKEN")
  if (token === undefined) return [fail("no DISCORD_TOKEN", `Put it in ${envFile}, or run: herdr-link init`, runInit)]
  const findings: Array<Finding> = []
  let app: Discord.Application
  try {
    app = await Discord.application(token)
  } catch (error) {
    return [fail(`the bot token does not work: ${(error as Error).message}`, "Run: herdr-link init", runInit)]
  }
  findings.push(okay(`bot ${app.name}`))
  findings.push(
    Discord.hasMessageContent(app)
      ? okay("Message Content intent")
      : fail("the Message Content intent is off: the bot cannot read messages", `https://discord.com/developers/applications/${app.id}/bot`, {
        label: "turn on the Message Content intent",
        run: async () => {
          await Discord.enableMessageContent(token, app)
        }
      })
  )
  if (app.bot_public) {
    findings.push(warn(
      "the bot is public: anyone could add it to their server",
      `Install Link: None, then Public Bot off: https://discord.com/developers/applications/${app.id}/installation`
    ))
  }
  try {
    const guilds = await Discord.guilds(token)
    const guild = guilds.find((g) => g.id === section.guild)
    findings.push(
      guild !== undefined
        ? okay(`on server ${guild.name}`)
        : fail(`the bot is not on server ${String(section.guild)}`, `Invite it: ${Discord.inviteUrl(app.id)}`)
    )
  } catch (error) {
    findings.push(warn(`cannot list the bot's servers: ${(error as Error).message}`, "Run herdr-link doctor again in a moment."))
  }
  const owner = Discord.owner(app)
  if (owner !== undefined && owner.id !== section.owner) {
    findings.push(warn(`owner in the config is not the app's owner (${owner.username})`, "Fine if intended."))
  }
  return findings
}

const checkAdapters = async (config: BridgeConfig.Config): Promise<Group> => {
  const findings: Array<Finding> = []
  for (const [name, section] of Object.entries(config.adapters)) {
    if (section.enabled === false) {
      findings.push(okay(`${name}: off (enabled = false)`))
      continue
    }
    const program = section.command[0]
    if (program === "herdr-link-discord") {
      findings.push(...(await checkDiscord(section)).map((f) => ({ ...f, text: `${name}: ${f.text}` })))
    } else {
      findings.push(
        program in builtIn || Probe.onPath(program) || existsSync(program)
          ? okay(`${name}: ${program}`)
          : fail(`${name}: ${program} is not found`, "Install that adapter, or fix `command` in the config.")
      )
    }
    for (const variable of section.env ?? []) {
      if (process.env[variable] === undefined && Config.readEnv(envFile, variable) === undefined) {
        findings.push(fail(`${name}: ${variable} is not set`, `Put it in ${envFile}.`))
      }
    }
  }
  return { title: "chat adapters", findings }
}

const checkHooks = (): Group => {
  const findings: Array<Finding> = []
  for (const [agent, state] of Object.entries(HookInstall.status())) {
    if (state === "ok") findings.push(okay(agent))
    else if (state === "absent") findings.push(okay(`${agent}: not on this machine`))
    else {
      findings.push(fail(
        state === "stale"
          ? `${agent}: hook is outdated or points to another install`
          : `${agent}: hook missing: replies won't reach the chat`,
        "Run: herdr-link hooks install",
        installHooks
      ))
    }
  }
  return { title: "agent hooks", findings }
}

const checkBridge = async (): Promise<Group> => {
  const findings: Array<Finding> = []
  let service: ReturnType<typeof Service.manager> | undefined
  try {
    service = Service.manager()
  } catch (error) {
    findings.push(warn((error as Error).message))
  }
  const install: Fix | undefined = service === undefined ? undefined : {
    label: `install and start the ${service.name} service`,
    run: async () => {
      for (const line of service!.install()) ok(line)
    }
  }
  const state = service?.status()
  if (service !== undefined && state !== undefined) {
    if (state.running) findings.push(okay(`${service.name}: ${state.details}`))
    else if (state.installed) findings.push(fail(`${service.name}: ${state.details}`, "See: herdr-link service logs", install))
    else findings.push(warn(`${service.name}: not installed`, "Fine if you run herdr-link run yourself.", install))
  }
  findings.push(
    (await answers(Hooks.defaultSocket()))
      ? okay("running and listening for hooks")
      : fail("not running", "Start it: herdr-link service install, or herdr-link run", install)
  )
  return { title: "bridge", findings }
}

const checkAll = async (): Promise<Array<Group>> => {
  const groups: Array<Group> = [await checkSystem()]
  const { config, group } = await checkConfig()
  groups.push(group)
  if (config !== undefined) groups.push(await checkAdapters(config))
  groups.push(checkHooks(), await checkBridge())
  return groups
}

const print = (groups: ReadonlyArray<Group>) => {
  for (const group of groups) {
    console.log(group.title)
    for (const finding of group.findings) {
      if (finding.status === "ok") ok(finding.text)
      else if (finding.status === "warn") note(`! ${finding.text}`)
      else bad(finding.text)
      if (finding.status !== "ok" && finding.hint !== undefined) note(`  ${finding.hint}`)
    }
  }
}

/** Returns the number of problems left. */
export const doctor = async (options: { readonly fix?: boolean; readonly yes?: boolean } = {}) => {
  let groups = await checkAll()
  print(groups)
  const broken = () => groups.flatMap((g) => g.findings).filter((f) => f.status === "fail")
  const fixable = () => groups.flatMap((g) => g.findings).filter((f) => f.status !== "ok" && f.fix !== undefined)

  if (options.fix) {
    const fixes = fixable()
    if (fixes.length === 0) console.log("\nNothing to fix automatically.")
    // One fix at a time, in order: installing herdr-core first lets the next checks pass.
    const done = new Set<string>()
    for (const finding of fixes) {
      const fix = finding.fix!
      if (done.has(fix.label)) continue
      done.add(fix.label)
      if (finding.status === "warn" && !options.yes && !(await confirm(`\nOptional: ${fix.label}?`, false))) continue
      if (fix.ask && finding.status === "fail" && !options.yes && !(await confirm(`\n${fix.label}?`))) continue
      console.log(`\n→ ${fix.label}`)
      try {
        await fix.run()
      } catch (error) {
        bad((error as Error).message)
      }
    }
    if (fixes.length > 0) {
      console.log("\nChecking again:")
      groups = await checkAll()
      print(groups)
    }
  } else if (fixable().length > 0) {
    console.log("\nherdr-link doctor --fix can fix some of this.")
  }

  const left = broken().length
  console.log(left === 0 ? "\nAll good." : `\n${left} problem${left === 1 ? "" : "s"}.`)
  return left
}
