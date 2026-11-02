import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as Config from "../src/Config.ts"
import { readEnv, renderConfig, writeEnv } from "../src/cli/config.ts"
import { launchdPlist, systemdUnit } from "../src/cli/service.ts"

const target = { shell: "/bin/zsh", node: "/opt/node/bin/node", bin: "/opt/herdr link/bin/herdr-link.mjs", home: "/home/me" }

describe("herdr-link init", () => {
  it.effect("writes a config the bridge accepts", () =>
    Effect.gen(function*() {
      const text = renderConfig({ owner: "1", guild: "2", agents: ["claude", "grok"], shell: "bash" })
      const config = yield* Config.parse(text, "config.toml")
      assert.deepStrictEqual(Object.keys(config.agents ?? {}), ["claude", "grok", "shell"])
      assert.deepStrictEqual(config.agents?.shell?.argv, ["bash", "-l"])
      assert.deepStrictEqual(Config.adapterConfig(config.adapters.discord!), { owner: "1", guild: "2" })
    }))

  it("keeps other lines of .env and makes it private", () => {
    const file = join(mkdtempSync(join(tmpdir(), "hl-env-")), "sub", ".env")
    writeEnv(file, "DISCORD_TOKEN", "a")
    writeEnv(file, "OTHER", "x")
    writeEnv(file, "DISCORD_TOKEN", "b")
    assert.strictEqual(readFileSync(file, "utf8"), "OTHER=x\nDISCORD_TOKEN=b\n")
    assert.strictEqual(readEnv(file, "DISCORD_TOKEN"), "b")
    assert.strictEqual(statSync(file).mode & 0o777, 0o600)
  })
})

describe("herdr-link service", () => {
  it("runs the bridge through the login shell, quoting paths", () => {
    const unit = systemdUnit(target)
    assert.include(unit, `ExecStart=/bin/zsh -lic 'exec '\\''/opt/node/bin/node'\\'' '\\''/opt/herdr link/bin/herdr-link.mjs'\\'' run'`)
    assert.include(unit, "Restart=always")
    const plist = launchdPlist(target)
    assert.include(plist, "<string>exec '/opt/node/bin/node' '/opt/herdr link/bin/herdr-link.mjs' run</string>")
    assert.include(plist, "<string>/home/me/Library/Logs/herdr-link.log</string>")
  })
})

describe("herdr-link hooks", () => {
  it("installs into Claude Code and Grok, replaces old entries, and uninstalls", () => {
    const home = mkdtempSync(join(tmpdir(), "hl-home-"))
    mkdirSync(join(home, ".claude"))
    mkdirSync(join(home, ".grok", "hooks"), { recursive: true })
    writeFileSync(join(home, ".grok", "hooks", "herdr-bridge.json"), "{}")
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
      model: "x",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }, { hooks: [{ type: "command", command: "node /old/herdr-bridge-hook.mjs" }] }] }
    }))
    const cli = (...args: Array<string>) =>
      execFileSync(process.execPath, [fileURLToPath(new URL("../bin/herdr-link.mjs", import.meta.url)), ...args], {
        env: { PATH: process.env.PATH, HOME: home }
      }).toString()

    cli("hooks", "install")
    cli("hooks", "install")
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))
    const stop = settings.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command))
    assert.strictEqual(stop.length, 2)
    assert.strictEqual(stop[0], "other")
    assert.include(stop[1], "herdr-link-hook.mjs")
    assert.strictEqual(settings.model, "x")
    assert.include(readFileSync(join(home, ".grok", "hooks", "herdr-link.json"), "utf8"), "herdr-link-hook.mjs")
    assert.throws(() => statSync(join(home, ".grok", "hooks", "herdr-bridge.json")))

    cli("hooks", "uninstall")
    const after = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))
    assert.deepStrictEqual(after.hooks, { Stop: [{ hooks: [{ type: "command", command: "other" }] }] })
  })
})
