import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as Hooks from "../src/bridge/Hooks.ts"

const script = fileURLToPath(new URL("../hooks/herdr-link-hook.mjs", import.meta.url))

/** Runs the hook like an agent would; async, because the listening server shares this process. */
const runHook = (socket: string, payload: object, terminal: string | null = "t5") =>
  Effect.promise(() =>
    new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [script], {
        env: { PATH: process.env.PATH, HERDR_LINK_SOCKET: socket, ...(terminal ? { HC_TERMINAL_ID: terminal } : {}) }
      })
      let output = ""
      child.stdout.on("data", (chunk) => (output += chunk))
      child.on("close", () => resolve(output))
      child.stdin.end(JSON.stringify(payload))
    })
  )

describe("agent hook", () => {
  it.live("forwards Stop replies (Grok field, Claude transcript) and skips the rest", () =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "hb-hook-"))
      const socket = join(dir, "hooks.sock")
      const messages = yield* Hooks.listen(socket)

      const transcript = join(dir, "t.jsonl")
      writeFileSync(transcript, [
        { type: "user", message: { content: "old question" } },
        { type: "assistant", message: { content: [{ type: "text", text: "old answer" }] } },
        { type: "user", message: { content: "fix the build" } },
        { type: "assistant", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use" }] } },
        { type: "user", message: { content: [{ type: "tool_result" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "Fixed: missing import." }] } }
      ].map((line) => JSON.stringify(line)).join("\n"))

      const fresh = join(dir, "fresh.jsonl")
      writeFileSync(fresh, [
        { type: "assistant", message: { content: [{ type: "text", text: "old answer" }] } },
        { type: "user", message: { content: "fix the build" } },
        { type: "assistant", message: { content: [{ type: "tool_use" }] } }
      ].map((line) => JSON.stringify(line)).join("\n"))

      // Not forwarded: outside herdr, a subagent, a session-end Stop, other events,
      // a tool call without a note in this turn yet.
      yield* runHook(socket, { hook_event_name: "Stop", last_assistant_message: "x" }, null)
      yield* runHook(socket, { hook_event_name: "Stop", last_assistant_message: "x", agent_id: "a1" })
      yield* runHook(socket, { hookEventName: "Stop", lastAssistantMessage: "x", reason: "shutdown" })
      yield* runHook(socket, { hook_event_name: "SessionStart" })
      yield* runHook(socket, { hook_event_name: "PreToolUse" })
      yield* runHook(socket, { hook_event_name: "PreToolUse", transcript_path: fresh })
      // Forwarded:
      const output = yield* runHook(socket, { hookEventName: "Stop", lastAssistantMessage: "grok says hi", reason: "end_turn" })
      assert.strictEqual(output, "") // prints nothing: never blocks the stop
      yield* runHook(socket, { hook_event_name: "Stop", transcript_path: transcript })
      // Before a tool call: the agent's latest note.
      yield* runHook(socket, { hook_event_name: "PreToolUse", transcript_path: transcript })
      // A question form: its questions, cleaned up.
      yield* runHook(socket, {
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_input: { questions: [{ question: "Pick one", header: "One", options: [{ label: "A", description: "first" }, { label: "" }, "junk"] }] }
      })

      const got = yield* messages.pipe(Stream.take(4), Stream.runCollect)
      assert.deepStrictEqual([...got], [
        { terminal: "t5", event: "Stop", text: "grok says hi" },
        { terminal: "t5", event: "Stop", text: "Looking.\n\nFixed: missing import." },
        { terminal: "t5", event: "PreToolUse", text: "Fixed: missing import." },
        {
          terminal: "t5",
          event: "PreToolUse",
          questions: [{ question: "Pick one", header: "One", multiSelect: false, options: [{ label: "A", description: "first" }] }]
        }
      ])
    }).pipe(Effect.scoped))

  it.live("refuses to start a second bridge on the same socket", () =>
    Effect.gen(function*() {
      const socket = join(mkdtempSync(join(tmpdir(), "hb-hook-")), "hooks.sock")
      yield* Hooks.listen(socket)
      const error = yield* Hooks.listen(socket).pipe(Effect.flip)
      assert.strictEqual(error.message, "another herdr-link is already running")
    }).pipe(Effect.scoped))

  it.live("exits quietly when no bridge is listening", () =>
    Effect.gen(function*() {
      const output = yield* runHook(join(tmpdir(), "no-such-bridge.sock"), { hook_event_name: "Stop", last_assistant_message: "x" })
      assert.strictEqual(output, "")
    }))
})
