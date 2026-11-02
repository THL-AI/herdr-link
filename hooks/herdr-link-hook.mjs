#!/usr/bin/env node
// The shared agent hook (Claude Code and Grok use the same format). Forwards
// the turn's final reply to the herdr-link over its unix socket. Plain Node,
// no dependencies. Never blocks the agent: prints nothing, always exits 0.
import { readFileSync } from "node:fs"
import { connect } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"

const terminal = process.env.HC_TERMINAL_ID
const socket = process.env.HERDR_LINK_SOCKET ?? join(homedir(), ".local/state/herdr-link/hooks.sock")
const forwarded = new Set(["Stop", "StopFailure", "Notification"])
const maxText = 32768

const readStdin = () => {
  try {
    return JSON.parse(readFileSync(0, "utf8"))
  } catch {
    return {}
  }
}

const field = (input, ...names) => {
  for (const name of names) if (typeof input[name] === "string" && input[name] !== "") return input[name]
  return undefined
}

/** Claude Code without `last_assistant_message`: the text after the last real user message. */
const lastReplyFromTranscript = (path) => {
  let lines
  try {
    lines = readFileSync(path, "utf8").trim().split("\n")
  } catch {
    return undefined
  }
  const parts = []
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry
    try {
      entry = JSON.parse(lines[i])
    } catch {
      continue
    }
    const content = entry?.message?.content
    if (entry.type === "user") {
      const isToolResult = Array.isArray(content) && content.some((block) => block?.type === "tool_result")
      if (!isToolResult) break
      continue
    }
    if (entry.type !== "assistant" || !Array.isArray(content)) continue
    const text = content.filter((b) => b?.type === "text").map((b) => b.text).join("\n")
    if (text.trim() !== "") parts.unshift(text)
  }
  return parts.length === 0 ? undefined : parts.join("\n\n")
}

const main = () => {
  if (!terminal) return
  const input = readStdin()
  const event = field(input, "hook_event_name", "hookEventName") ?? process.argv[2]
  if (!forwarded.has(event)) return
  if (input.agent_id || input.subagentType) return // subagents report to their parent, not to the owner
  const reason = field(input, "reason")
  if (event === "Stop" && reason !== undefined && reason !== "end_turn") return // session-end Stop (Grok)

  let text = field(input, "last_assistant_message", "lastAssistantMessage")
  if (text === undefined && event === "Stop") {
    const transcript = field(input, "transcript_path", "transcriptPath")
    if (transcript) text = lastReplyFromTranscript(transcript)
  }
  const message = {
    terminal,
    event,
    ...(text === undefined ? {} : { text: text.slice(0, maxText) }),
    ...(field(input, "notification_type", "notificationType") ? { kind: field(input, "notification_type", "notificationType") } : {}),
    ...(field(input, "message") ? { message: field(input, "message") } : {}),
    ...(field(input, "error") ? { error: field(input, "error") } : {})
  }

  const client = connect(socket)
  const done = () => process.exit(0)
  client.setTimeout(3000, done)
  client.on("error", done) // no bridge running: nothing to do
  client.on("connect", () => client.end(`${JSON.stringify(message)}\n`))
  client.on("close", done)
}

try {
  main()
} catch {
  process.exit(0)
}
