#!/usr/bin/env node
// The shared agent hook (Claude Code and Grok use the same format). Forwards
// the turn's final reply to herdr-link over its unix socket, and before each
// tool call the agent's latest note (its short text between actions), which
// herdr-link shows as the turn's progress. Plain Node, no dependencies. Never
// blocks the agent: prints nothing, always exits 0.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs"
import { connect } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"

const terminal = process.env.HC_TERMINAL_ID
const socket = process.env.HERDR_LINK_SOCKET ?? join(homedir(), ".local/state/herdr-link/hooks.sock")
const forwarded = new Set(["Stop", "StopFailure", "Notification", "PreToolUse"])
const maxText = 32768
/** Before a tool call only the transcript's end is read: it can grow to many megabytes. */
const tailBytes = 256 * 1024

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

/** The last lines of a file, without the first (likely cut) one. */
const tailLines = (path) => {
  let fd
  try {
    fd = openSync(path, "r")
    const size = fstatSync(fd).size
    const length = Math.min(size, tailBytes)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const lines = buffer.toString("utf8").split("\n")
    return size > length ? lines.slice(1) : lines
  } catch {
    return []
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** The agent's latest text in this turn (Claude Code transcripts), if any. */
const latestNote = (path) => {
  const lines = tailLines(path)
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
      if (!isToolResult) return undefined // the owner's message: no note in this turn yet
      continue
    }
    if (entry.type !== "assistant" || !Array.isArray(content)) continue
    const text = content.filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim()
    if (text !== "") return text
  }
  return undefined
}

/** The questions of Claude Code's AskUserQuestion, so the chat can show them with buttons. */
const askedQuestions = (input) => {
  const toolInput = input.tool_input ?? input.toolInput
  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : []
  const clean = questions.flatMap((q) => {
    const options = (Array.isArray(q?.options) ? q.options : []).flatMap((o) =>
      typeof o?.label === "string" && o.label !== ""
        ? [{ label: o.label.slice(0, 200), ...(typeof o.description === "string" ? { description: o.description.slice(0, 500) } : {}) }]
        : []
    )
    return typeof q?.question === "string" && options.length > 0
      ? [{
        question: q.question.slice(0, 1000),
        ...(typeof q.header === "string" ? { header: q.header.slice(0, 100) } : {}),
        multiSelect: q.multiSelect === true,
        options
      }]
      : []
  })
  return clean.length === 0 ? undefined : clean
}

const send = (message, timeout) => {
  const client = connect(socket)
  const done = () => process.exit(0)
  client.setTimeout(timeout, done)
  client.on("error", done) // no bridge running: nothing to do
  client.on("connect", () => client.end(`${JSON.stringify(message)}\n`))
  client.on("close", done)
}

const main = () => {
  if (!terminal) return
  const input = readStdin()
  const event = field(input, "hook_event_name", "hookEventName") ?? process.argv[2]
  if (!forwarded.has(event)) return
  if (input.agent_id || input.subagentType) return // subagents report to their parent, not to the owner
  const reason = field(input, "reason")
  if (event === "Stop" && reason !== undefined && reason !== "end_turn") return // session-end Stop (Grok)

  if (event === "PreToolUse") {
    const transcript = field(input, "transcript_path", "transcriptPath")
    const note = transcript ? latestNote(transcript) : undefined
    const questions = field(input, "tool_name", "toolName") === "AskUserQuestion" ? askedQuestions(input) : undefined
    if (note === undefined && questions === undefined) return
    // Runs before every tool call: give up fast rather than slow the agent down.
    send({
      terminal,
      event,
      ...(note === undefined ? {} : { text: note.slice(0, 2000) }),
      ...(questions === undefined ? {} : { questions })
    }, 500)
    return
  }

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
  send(message, 3000)
}

try {
  main()
} catch {
  process.exit(0)
}
