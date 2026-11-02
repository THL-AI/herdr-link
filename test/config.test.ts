import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Config from "../src/Config.ts"

const example = `
[adapters.discord]
command = ["herdr-link-discord"]
env = ["DISCORD_TOKEN"]
owner = "123"
guild = "456"

[agents.claude]
template = "claude"
emoji = "✳️"
logo = "claude"
allow = ["1"]
deny = ["esc"]

[agents.shell]
argv = ["zsh", "-l"]
emoji = "🐚"
`

describe("Config", () => {
  it.effect("parses the example and splits off the adapter's own section", () =>
    Effect.gen(function*() {
      const config = yield* Config.parse(example, "example.toml")
      const discord = config.adapters.discord!
      assert.deepStrictEqual(discord.command, ["herdr-link-discord"])
      assert.deepStrictEqual(Config.adapterConfig(discord), { owner: "123", guild: "456" })
      assert.strictEqual(config.agents?.shell?.argv?.[0], "zsh")
    }))

  it.effect("keeps a turned-off adapter out of the start list, and its switches out of hello", () =>
    Effect.gen(function*() {
      const config = yield* Config.parse(
        `${example}\n[adapters.telegram]\ncommand = ["herdr-link-telegram"]\nenabled = false\ndashboard = false\nowner = "1"\n`,
        "x.toml"
      )
      assert.deepStrictEqual(Object.keys(Config.enabledAdapters(config.adapters)), ["discord"])
      assert.deepStrictEqual(Config.adapterConfig(config.adapters.telegram!), { owner: "1" })
    }))

  it.effect.each([
    ["no command", `[adapters.x]\nowner = "1"`],
    ["empty command", `[adapters.x]\ncommand = []`],
    ["template and argv", `[adapters.x]\ncommand = ["a"]\n[agents.a]\ntemplate = "t"\nargv = ["b"]\nemoji = "x"`],
    ["neither template nor argv", `[adapters.x]\ncommand = ["a"]\n[agents.a]\nemoji = "x"`],
    ["typo in an agent", `[adapters.x]\ncommand = ["a"]\n[agents.a]\ntemplate = "t"\nemoji = "x"\nalow = ["1"]`],
    ["unknown top-level key", `token = "oops"\n[adapters.x]\ncommand = ["a"]`],
    ["bad env name", `[adapters.x]\ncommand = ["a"]\nenv = ["A B"]`],
    ["not TOML", `[adapters.x`]
  ])("rejects %s", ([, text]) =>
    Effect.gen(function*() {
      const error = yield* Config.parse(text!, "bad.toml").pipe(Effect.flip)
      assert.strictEqual(error._tag, "ConfigError")
    }))
})
