import { assert, describe, it } from "@effect/vitest"
import { menu, parseCommand, toHtml } from "../src/adapters/telegram/Text.ts"
import type { CommandSpec } from "../src/protocol/Chat.ts"

describe("toHtml", () => {
  it("escapes HTML and keeps code verbatim", () => {
    assert.strictEqual(toHtml("a < b & \"c\""), "a &lt; b &amp; &quot;c&quot;")
    assert.strictEqual(toHtml("run `ls **x**` now"), "run <code>ls **x**</code> now")
    assert.strictEqual(toHtml("```ts\nconst a = 1 < 2\n```"), "<pre><code class=\"language-ts\">const a = 1 &lt; 2</code></pre>")
    assert.strictEqual(toHtml("```\nplain\n```"), "<pre>plain</pre>")
    assert.strictEqual(toHtml("```inline```"), "<pre>inline</pre>")
  })

  it("converts bold, italics, strike-through, links, headings and quotes", () => {
    assert.strictEqual(toHtml("**bold** and *it* and _it_ ~~gone~~"), "<b>bold</b> and <i>it</i> and <i>it</i> <s>gone</s>")
    assert.strictEqual(toHtml("[docs](https://x.dev/a?b=1&c=2)"), "<a href=\"https://x.dev/a?b=1&amp;c=2\">docs</a>")
    assert.strictEqual(toHtml("## Title\ntext"), "<b>Title</b>\ntext")
    assert.strictEqual(toHtml("> one\n> two\nafter"), "<blockquote>one\ntwo</blockquote>\nafter")
  })

  it("leaves snake_case, globs and arithmetic alone", () => {
    assert.strictEqual(toHtml("my_var_name and 2*3*4 and *.ts"), "my_var_name and 2*3*4 and *.ts")
  })
})

const specs: ReadonlyArray<CommandSpec> = [
  { name: "status", description: "What every agent is doing", options: [] },
  {
    name: "space new",
    description: "Make a herdr space",
    options: [
      { name: "name", description: "n", type: "string", required: true },
      { name: "folder", description: "f", type: "string", required: true },
      { name: "agent", description: "a", type: "string", required: false, choices: ["claude", "grok"] },
      { name: "task", description: "t", type: "string", required: false }
    ]
  }
]

describe("parseCommand", () => {
  it("reads positional arguments, choices only when they match, the rest as the last text", () => {
    assert.deepStrictEqual(parseCommand("/space new api ~/p claude fix the login", specs, "bot"), {
      _tag: "command",
      command: "space new",
      args: { name: "api", folder: "~/p", agent: "claude", task: "fix the login" }
    })
    assert.deepStrictEqual(parseCommand("/space new \"my api\" ~/p fix it", specs, "bot"), {
      _tag: "command",
      command: "space new",
      args: { name: "my api", folder: "~/p", task: "fix it" }
    })
    assert.deepStrictEqual(parseCommand("/status@Bot", specs, "bot"), { _tag: "command", command: "status", args: {} })
  })

  it("answers with usage when arguments are missing, and skips other bots' commands", () => {
    assert.deepStrictEqual(parseCommand("/space new api", specs, "bot"), {
      _tag: "usage",
      text: "/space new <name> <folder> [agent] [task]"
    })
    assert.deepStrictEqual(parseCommand("/space", specs, "bot"), { _tag: "usage", text: "/space new <name> <folder> [agent] [task]" })
    assert.deepStrictEqual(parseCommand("/status@other_bot", specs, "bot"), { _tag: "unknown" })
    assert.deepStrictEqual(parseCommand("/start", specs, "bot"), { _tag: "unknown" })
  })

  it("lists top-level commands for the menu", () => {
    assert.deepStrictEqual(menu(specs), [
      { command: "status", description: "What every agent is doing" },
      { command: "space", description: "space new <name> <folder> [agent] [task]: Make a herdr space" }
    ])
  })
})
