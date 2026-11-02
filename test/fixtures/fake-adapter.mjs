// A minimal Chat adapter in plain Node.js, used by the tests: proves the
// protocol needs nothing from Effect. Commands are driven by message.post text.
import { createInterface } from "node:readline"

const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
const notify = (method, params) => write({ method, params })
let config = {}

const handlers = {
  hello(params) {
    config = params.config
    if (config.reject) throw { code: -32003, message: "bad config" }
    console.error(`hello from fake, ${params.commands.length} commands`)
    return {
      protocol: 1,
      adapter: { name: "fake", version: "0.0.0" },
      capabilities: {
        rooms: true, direct: true, threadCreation: true, actions: true, reactions: true, customEmoji: false,
        commands: true, edit: true, files: false, maxText: 2000, maxActions: 5
      }
    }
  },
  "message.post"({ place, text }) {
    if (text === "exit") setTimeout(() => process.exit(1), 10)
    if (text === "env") {
      const seen = ["FAKE_TOKEN", "OTHER_SECRET"].filter((key) => process.env[key] !== undefined)
      notify("message.received", { place, message: "2", text: seen.join(","), attachments: [] })
    }
    if (text === "config") notify("message.received", { place, message: "3", text: JSON.stringify(config), attachments: [] })
    return { message: "1" }
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (!("method" in message)) return
  const handler = handlers[message.method]
  try {
    if (!handler) throw { code: -32601, message: `unknown method ${message.method}` }
    write({ id: message.id, result: handler(message.params) })
  } catch (error) {
    write({ id: message.id, error: { code: error.code ?? -32603, message: error.message ?? String(error) } })
  }
})
