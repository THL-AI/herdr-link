/** The `herdr-link` command. */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { doctor } from "./doctor.ts"
import * as Hooks from "./hooks.ts"
import { init } from "./init.ts"
import * as Mod from "./mod.ts"
import { packageRoot } from "./paths.ts"
import { ok } from "./prompt.ts"
import * as Service from "./service.ts"
import * as Settings from "./settings.ts"
import { telegram } from "./telegram.ts"

const usage = `herdr-link: your herdr agents in a chat app

  herdr-link init                 set it up (bot, config, hooks, service)
  herdr-link doctor [--fix]       check every piece; --fix repairs what it can
  herdr-link status [--json]      is it running, which chat apps are connected
  herdr-link desk [on | off]      at the computer (no pushes) or away (pushes)
  herdr-link adapter <name> on | off             start that chat app or not
  herdr-link adapter <name> dashboard on | off   its live status in your DMs
  herdr-link run [config.toml]    run the bridge in the foreground
  herdr-link service install | uninstall | restart | status | logs
  herdr-link hooks install | uninstall
  herdr-link mod install | uninstall   its bar in the Herdr window
  herdr-link telegram             find the ids a Telegram setup needs
  herdr-link --version`

const [command = "help", sub, ...rest] = process.argv.slice(2)

const main = async () => {
  switch (command) {
    case "run": {
      const { start } = await import("../main.ts")
      return start(sub)
    }
    case "init":
      return init()
    case "doctor": {
      const flags = [sub, ...rest]
      const left = await doctor({ fix: flags.includes("--fix"), yes: flags.includes("--yes") || flags.includes("-y") })
      process.exitCode = left === 0 ? 0 : 1
      return
    }
    case "hooks":
      if (sub !== "install" && sub !== "uninstall") break
      for (const line of Hooks.install(sub === "uninstall")) ok(line)
      return
    case "service": {
      const service = Service.manager()
      if (sub === "install" || sub === "uninstall" || sub === "restart") {
        for (const line of service[sub]()) ok(line)
        return
      }
      if (sub === "status") return console.log(`${service.name}: ${service.status().details}`)
      if (sub === "logs") return console.log(service.logs())
      break
    }
    case "status":
      process.exitCode = Settings.status(sub === "--json")
      return
    case "desk":
      process.exitCode = Settings.desk(sub)
      return
    case "adapter":
      process.exitCode = Settings.adapter([sub, ...rest])
      return
    case "mod":
      if (sub !== "install" && sub !== "uninstall") break
      process.exitCode = sub === "install" ? Mod.install() : Mod.uninstall()
      return
    case "telegram":
      process.exitCode = await telegram()
      return
    case "--version":
    case "-v":
      return console.log(JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version)
  }
  console.log(usage)
  if (command !== "help" && command !== "--help" && command !== "-h") process.exitCode = 1
}

main().catch((error) => {
  console.error(`herdr-link: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
