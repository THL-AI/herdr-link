import { assert, describe, it } from "@effect/vitest"
import { Deferred, type Duration, Effect, Queue, Result, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as Store from "../src/bridge/Store.ts"
import * as Bridge from "../src/bridge/Bridge.ts"
import type { HookMessage } from "../src/bridge/Hooks.ts"
import { chunk } from "../src/bridge/Text.ts"
import type { Chat, ChatEvent } from "../src/chat/Chat.ts"
import type { Agent } from "../src/Config.ts"
import type { CoreEvent } from "../src/core/Events.ts"
import { CoreError, type HerdrCore } from "../src/core/HerdrCore.ts"
import type { Terminal } from "../src/core/Methods.ts"
import { ActionId, MessageId, RoomId, ThreadId } from "../src/protocol/Chat.ts"
import { createServer } from "node:http"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const agents: Record<string, Agent> = {
  claude: { template: "claude", emoji: "✳️", allow: ["1"], always: ["2"], deny: ["esc"], trust: ["y"] },
  shell: { argv: ["zsh", "-l"], emoji: "🐚" }
}

const terminal = (address: string, extra: Partial<Terminal> = {}): Terminal => ({
  address,
  labels: {},
  argv: ["zsh"],
  cwd: "/tmp",
  state: "live",
  created_ms: 0,
  ...extra
})

const layout = {
  spaces: [{
    id: "sp1",
    name: "api",
    folder: "/p/api",
    tabs: [
      { id: "tb1", name: "main", root: { type: "block", id: "p1", content: { terminal: "t1" } } },
      { id: "tb2", name: "Shell Tab", root: { type: "block", id: "p2", content: { terminal: "t2" } } }
    ]
  }]
}

const capabilities = {
  rooms: true,
  direct: true,
  threadCreation: true,
  actions: true,
  reactions: true,
  customEmoji: true,
  commands: false,
  edit: true,
  files: true,
  maxText: 2000,
  maxActions: 25
}

const setupWith = (
  extra: {
    readonly dashboardEvery?: Duration.Input
    readonly progressEvery?: Duration.Input
    readonly withoutDashboard?: ReadonlyArray<string>
    readonly machine?: string
    readonly atDesk?: () => boolean
  } = {}
) => Effect.gen(function*() {
  const docs = new Map<string, { value: unknown; version: number }>([["herdr-app", { value: layout, version: 1 }]])
  const coreEvents = yield* Queue.unbounded<CoreEvent>()
  const chatEvents = yield* Queue.unbounded<ChatEvent>()
  const calls = yield* Queue.unbounded<{ method: string; params: any }>()
  const hooks = yield* Queue.unbounded<HookMessage>()
  const coreCalls = yield* Queue.unbounded<{ method: string; params: any }>()

  const core = {
    call: (method: string, params: any) =>
      Effect.suspend((): Effect.Effect<unknown, CoreError> => {
        if (method === "doc.get") return Effect.succeed(docs.get(params.name) ?? { value: null, version: 0 })
        if (method === "doc.set") {
          const version = (docs.get(params.name)?.version ?? 0) + 1
          docs.set(params.name, { value: params.value, version })
          return Effect.succeed({ version })
        }
        if (method === "terminal.read") return Effect.succeed({ text: "line 1   \n```code```\n$ ready\n\n\n", complete: true, how: "screen" })
        if (method === "terminal.put") {
          return Queue.offer(coreCalls, { method, params }).pipe(
            Effect.as({ path: `/state/files/${params.terminal}/${params.name}`, bytes: Buffer.from(params.data, "base64").length })
          )
        }
        if (method === "terminal.keys") return Queue.offer(coreCalls, { method, params }).pipe(Effect.as({ turn: 1 }))
        if (method === "terminal.send") {
          return Queue.offer(coreCalls, { method, params }).pipe(
            Effect.andThen(params.text === "blocked" ? Effect.fail(new CoreError({ method, kind: "blocked", message: "blocked" })) : Effect.succeed({ turn: 1 }))
          )
        }
        return Effect.fail(new CoreError({ method, kind: "not_found", message: method }))
      }),
    events: Stream.fromQueue(coreEvents)
  } as unknown as HerdrCore["Service"]

  const chat = {
    connected: Effect.succeed([]),
    states: Effect.succeed([]),
    call: (_adapter: string, method: string, params: any) =>
      Queue.offer(calls, { method, params }).pipe(Effect.as(
        method === "room.ensure"
          ? { room: params.room ?? RoomId.make(`room-${params.name}`), created: params.room === undefined }
          : method === "thread.ensure"
          ? { thread: params.thread ?? ThreadId.make(`thread-${params.name}`), created: params.thread === undefined }
          : { message: "m1" }
      )),
    notify: (_adapter: string, method: string, params: any) => Queue.offer(calls, { method, params }).pipe(Effect.asVoid),
    events: Stream.fromQueue(chatEvents)
  } as unknown as Chat["Service"]

  const closedTabs = yield* Queue.unbounded<string>()
  const appCalls = yield* Queue.unbounded<{ method: string; params: any }>()
  yield* Bridge.run({
    chat,
    core,
    agents,
    hooks: Stream.fromQueue(hooks),
    ...extra,
    app: {
      closeTab: (id) => Queue.offer(closedTabs, id).pipe(Effect.asVoid),
      newTab: (tab) =>
        Queue.offer(appCalls, { method: "tab.new", params: tab }).pipe(Effect.as({ space: tab.space, tab: "tb-new", terminal: "t9" })),
      newSpace: (space) =>
        Queue.offer(appCalls, { method: "space.new", params: space }).pipe(
          Effect.as(space.tab === undefined ? { space: "sp-new" } : { space: "sp-new", tab: "tb-first", terminal: "t8" })
        ),
      closeSpace: (id) => Queue.offer(appCalls, { method: "space.close", params: { id } }).pipe(Effect.asVoid)
    }
  }).pipe(Effect.forkScoped)
  const take = Queue.take(calls)
  return { docs, coreEvents, chatEvents, take, calls, hooks, coreCalls, closedTabs, appCalls }
})
const setup = setupWith()

/** A new thread's tab starts a moment later: move the clock until it does. */
const untilTab = (env: { readonly appCalls: Queue.Queue<{ method: string; params: any }> }) =>
  Effect.gen(function*() {
    for (let i = 0; i < 20 && (yield* Queue.size(env.appCalls)) === 0; i++) yield* TestClock.adjust("500 millis")
  })

describe("Bridge", () => {
  it.effect("creates a room per space and a thread per tab, named with the agent's emoji", () =>
    Effect.gen(function*() {
      const { docs, coreEvents, chatEvents, take } = yield* setup
      yield* Queue.offer(coreEvents, {
        _tag: "snapshot",
        seq: 1,
        terminals: [terminal("t1", { template: "claude" }), terminal("t2", { foreground: { pid: 1, name: "zsh", argv: ["zsh"], cwd: "/" } })]
      })
      yield* Queue.offer(chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })

      const room = yield* take
      assert.deepStrictEqual(room, { method: "room.ensure", params: { name: "api" } })
      const t1 = yield* take
      assert.strictEqual(t1.params.name, "✳️main")
      assert.strictEqual(t1.params.room, "room-api")
      const t2 = yield* take
      assert.strictEqual(t2.params.name, "🐚Shell Tab")

      yield* Effect.yieldNow
      const saved = docs.get(Store.docName)?.value as Store.State
      assert.deepStrictEqual(saved.adapters.discord, {
        rooms: { sp1: "room-api" },
        threads: { tb1: { thread: "thread-✳️main", emoji: "✳️" }, tb2: { thread: "thread-🐚Shell Tab", emoji: "🐚" } }
      })

      // A layout change resyncs, reusing the stored ids.
      yield* Queue.offer(coreEvents, { _tag: "doc", seq: 2, name: "herdr-app", version: 2 })
      assert.strictEqual((yield* take).params.room, "room-api")
      assert.strictEqual((yield* take).params.thread, "thread-✳️main")
      yield* take
    }))

  it.effect("names an unnamed space as herdr-app does, following its terminal; an unnamed tab by its place", () =>
    Effect.gen(function*() {
      const { docs, coreEvents, chatEvents, take } = yield* setup
      docs.set("herdr-app", {
        value: {
          spaces: [{
            id: "sp9",
            name: "",
            folder: process.env.HOME,
            tabs: [{ id: "tb9", name: "", root: { type: "block", id: "p9", content: { terminal: "t9" } } }]
          }]
        },
        version: 1
      })
      yield* Queue.offer(coreEvents, { _tag: "snapshot", seq: 1, terminals: [terminal("t9")] })
      yield* Queue.offer(chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })
      assert.deepStrictEqual((yield* take).params, { name: "~" })
      assert.strictEqual((yield* take).params.name, "1")

      // `cd ~/Projects/ram` in its terminal: herdr-app relabels it and the room follows.
      yield* Queue.offer(coreEvents, { _tag: "labels", seq: 2, address: "t9", labels: { where: "ram / 1" } })
      assert.deepStrictEqual((yield* take).params, { room: "room-~", name: "ram" })
      assert.strictEqual((yield* take).params.topic, "ram / 1 — " + process.env.HOME)
    }))

  it.effect("posts when an agent turns done or blocked, once per change", () =>
    Effect.gen(function*() {
      const { coreEvents, chatEvents, take, calls } = yield* setup
      yield* Queue.offer(coreEvents, { _tag: "snapshot", seq: 1, terminals: [terminal("t1", { template: "claude" })] })
      yield* Queue.offer(chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })
      yield* Effect.all([take, take, take])

      const status = (seq: number, state: string, extra: object = {}): CoreEvent => ({
        _tag: "status",
        seq,
        address: "t1",
        status: { state, app: "claude-code", ...extra }
      })
      yield* Queue.offer(coreEvents, status(2, "working"))
      yield* Queue.offer(coreEvents, status(3, "done", { msg: "tests pass" }))
      yield* Queue.offer(coreEvents, status(4, "done", { msg: "again" }))
      yield* Queue.offer(coreEvents, status(5, "blocked", { kind: "auth", msg: "Sign in to Grok" }))

      // `blocked` goes out at once; `done` waits for a hook reply first.
      assert.strictEqual((yield* take).params.text, "⚠️ Needs you (auth): Sign in to Grok")
      yield* TestClock.adjust("5 seconds")
      const done = yield* take
      assert.deepStrictEqual(done, {
        method: "message.post",
        params: { place: { kind: "thread", thread: "thread-✳️main" }, text: "✅ Done: tests pass" }
      })
      yield* TestClock.adjust("5 seconds")
      assert.strictEqual(yield* Queue.size(calls), 0)
    }))

  it.effect("posts without a push while the owner is at the desk", () =>
    Effect.gen(function*() {
      let desk = true
      const { coreEvents, chatEvents, take } = yield* setupWith({ atDesk: () => desk })
      yield* Queue.offer(coreEvents, { _tag: "snapshot", seq: 1, terminals: [terminal("t1", { template: "claude" })] })
      yield* Queue.offer(chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })
      const sync = yield* Effect.all([take, take, take])
      assert.isTrue(sync.every((call) => call.params.silent === undefined)) // only posts and questions

      const blocked = (seq: number): CoreEvent => ({
        _tag: "status",
        seq,
        address: "t1",
        status: { state: "blocked", app: "claude-code", kind: "auth", msg: "Sign in" }
      })
      yield* Queue.offer(coreEvents, blocked(2))
      assert.strictEqual((yield* take).params.silent, true)
      desk = false
      yield* Queue.offer(coreEvents, { _tag: "status", seq: 3, address: "t1", status: { state: "working", app: "claude-code" } })
      yield* Queue.offer(coreEvents, blocked(4))
      assert.strictEqual((yield* take).params.silent, undefined)
    }))

  it.effect("posts the hook's reply instead of a bare Done, split to the adapter's limit", () =>
    Effect.gen(function*() {
      const { coreEvents, chatEvents, take, calls, hooks } = yield* setup
      yield* Queue.offer(coreEvents, { _tag: "snapshot", seq: 1, terminals: [terminal("t1", { template: "claude" })] })
      yield* Queue.offer(chatEvents, {
        _tag: "adapter.connected",
        adapter: "discord",
        info: { name: "d", version: "0" },
        capabilities: { ...capabilities, maxText: 100 }
      })
      yield* Effect.all([take, take, take])

      yield* Queue.offer(coreEvents, { _tag: "status", seq: 2, address: "t1", status: { state: "working" } })
      yield* Queue.offer(coreEvents, { _tag: "status", seq: 3, address: "t1", status: { state: "done" } })
      const reply = Array.from({ length: 12 }, (_, i) => `line ${i} of the answer`).join("\n")
      yield* Queue.offer(hooks, { terminal: "t1", event: "Stop", text: reply })
      const parts = chunk(reply, 100)
      assert.isAbove(parts.length, 1)
      for (const part of parts) {
        const posted = yield* take
        assert.strictEqual(posted.params.place.thread, "thread-✳️main")
        assert.strictEqual(posted.params.text, part)
      }
      yield* TestClock.adjust("5 seconds")
      assert.strictEqual(yield* Queue.size(calls), 0) // no bare "Done"
    }))

  it.effect("shows a long turn's progress in one message, edited, then shrunk to one line", () =>
    Effect.gen(function*() {
      const { coreEvents, chatEvents, take, calls, hooks } = yield* setupWith({ progressEvery: "15 seconds" })
      yield* Queue.offer(coreEvents, { _tag: "snapshot", seq: 1, terminals: [terminal("t1", { template: "claude" })] })
      yield* Queue.offer(chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })
      yield* Effect.all([take, take, take])

      yield* Queue.offer(coreEvents, { _tag: "status", seq: 2, address: "t1", status: { state: "working" } })
      yield* Queue.offer(hooks, { terminal: "t1", event: "PreToolUse", text: "Reading the code.\nmore detail" })
      yield* TestClock.adjust("30 seconds")
      assert.strictEqual(yield* Queue.size(calls), 0) // a quick turn gets no status message

      yield* TestClock.adjust("30 seconds")
      const posted = yield* take
      assert.deepStrictEqual(posted.params, {
        place: { kind: "thread", thread: "thread-✳️main" },
        text: "⏳ working · 1 min\n› Reading the code."
      })
      yield* Queue.offer(hooks, { terminal: "t1", event: "PreToolUse", text: "Reading the code." }) // same note: nothing new
      yield* Queue.offer(hooks, { terminal: "t1", event: "PreToolUse", text: "Tests pass; writing docs." })
      yield* TestClock.adjust("15 seconds")
      const edited = yield* take
      assert.deepStrictEqual([edited.method, edited.params.text], [
        "message.edit",
        "⏳ working · 1 min\n› Reading the code.\n› Tests pass; writing docs."
      ])
      yield* TestClock.adjust("15 seconds")
      assert.strictEqual(yield* Queue.size(calls), 0) // nothing changed: no edit

      yield* TestClock.adjust("60 seconds")
      yield* take // "2 min"
      yield* Queue.offer(coreEvents, { _tag: "status", seq: 3, address: "t1", status: { state: "done" } })
      const last = yield* take
      assert.deepStrictEqual([last.method, last.params.message, last.params.text], ["message.edit", "m1", "✅ worked 2 min"])
    }))

  it.effect("types the owner's message into the tab's agent and marks it seen", () =>
    Effect.gen(function*() {
      const { coreEvents, chatEvents, take, coreCalls } = yield* setup
      yield* Queue.offer(coreEvents, {
        _tag: "snapshot",
        seq: 1,
        terminals: [terminal("t1", { template: "claude" }), terminal("t2")]
      })
      yield* Queue.offer(chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })
      yield* Effect.all([take, take, take])

      const received = (thread: string, text: string): ChatEvent => ({
        _tag: "message.received",
        adapter: "discord",
        params: {
          place: { kind: "thread", thread: ThreadId.make(thread) },
          message: MessageId.make("m9"),
          text,
          attachments: []
        }
      })
      yield* Queue.offer(chatEvents, received("thread-✳️main", "run the tests"))
      assert.deepStrictEqual(yield* Queue.take(coreCalls), {
        method: "terminal.send",
        params: { terminal: "t1", text: "run the tests" }
      })
      const seen = yield* take
      assert.strictEqual(seen.method, "react")
      assert.deepStrictEqual(seen.params.emoji, { kind: "unicode", value: "👀" })

      yield* Queue.offer(chatEvents, received("thread-✳️main", "blocked"))
      yield* Queue.take(coreCalls)
      const refused = yield* take
      assert.strictEqual(refused.method, "message.post")
      assert.include(refused.params.text, "waiting on a prompt")
      assert.strictEqual(refused.params.replyTo, "m9")

      // A channel the bridge did not make: ignored.
      yield* Queue.offer(chatEvents, received("someone-elses-channel", "hi"))
      yield* Effect.yieldNow
      assert.strictEqual(yield* Queue.size(coreCalls), 0)
    }))
})

describe("permission prompts", () => {
  const connect = (setupValue: Effect.Success<typeof setup>) =>
    Effect.gen(function*() {
      const { coreEvents, chatEvents, take } = setupValue
      yield* Queue.offer(coreEvents, { _tag: "snapshot", seq: 1, terminals: [terminal("t1", { template: "claude" })] })
      yield* Queue.offer(chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })
      yield* Effect.all([take, take, take])
    })
  const blocked = (seq: number, msg: string): CoreEvent => ({
    _tag: "status",
    seq,
    address: "t1",
    status: { state: "blocked", kind: "permission", msg, app: "claude-code" }
  })
  const pressed = (action: string): ChatEvent => ({
    _tag: "action.pressed",
    adapter: "discord",
    params: { place: { kind: "thread", thread: ThreadId.make("thread-✳️main") }, message: MessageId.make("m1"), action: ActionId.make(action) }
  })

  it.effect("shows Allow / Allow always / Deny and types the agent's keys", () =>
    Effect.gen(function*() {
      const env = yield* setup
      yield* connect(env)
      yield* Queue.offer(env.coreEvents, blocked(2, "approve Bash: pnpm test"))
      const prompt = yield* env.take
      assert.strictEqual(prompt.params.text, "🔐 Permission: approve Bash: pnpm test")
      assert.deepStrictEqual(prompt.params.actions.map((a: any) => [a.id, a.label]), [
        ["prompt:1:allow", "Allow"],
        ["prompt:1:always", "Allow always"],
        ["prompt:1:deny", "Deny"]
      ])

      yield* Queue.offer(env.chatEvents, pressed("prompt:1:allow"))
      assert.deepStrictEqual(yield* Queue.take(env.coreCalls), { method: "terminal.keys", params: { terminal: "t1", keys: ["1"] } })
      const edited = yield* env.take
      assert.deepStrictEqual(edited, {
        method: "message.edit",
        params: {
          place: { kind: "thread", thread: "thread-✳️main" },
          message: "m1",
          text: "🔐 Permission: approve Bash: pnpm test\n→ ✅ Allowed",
          actions: []
        }
      })

      // The agent moves on; a second press on the old buttons only clears them.
      yield* Queue.offer(env.coreEvents, { _tag: "status", seq: 3, address: "t1", status: { state: "working" } })
      yield* Queue.offer(env.chatEvents, pressed("prompt:1:deny"))
      assert.deepStrictEqual((yield* env.take).params, {
        place: { kind: "thread", thread: "thread-✳️main" },
        message: "m1",
        actions: []
      })
      assert.strictEqual(yield* Queue.size(env.coreCalls), 0)
    }))

  it.effect("offers only Trust for a trust-this-folder question", () =>
    Effect.gen(function*() {
      const env = yield* setup
      yield* connect(env)
      yield* Queue.offer(env.coreEvents, blocked(2, "Trust this folder?"))
      const prompt = yield* env.take
      assert.strictEqual(prompt.params.text, "🔐 Permission: Trust this folder?\n(to refuse, answer it in herdr)")
      assert.deepStrictEqual(prompt.params.actions.map((a: any) => [a.id, a.label]), [["prompt:1:allow", "Trust"]])
      yield* Queue.offer(env.chatEvents, pressed("prompt:1:allow"))
      assert.deepStrictEqual((yield* Queue.take(env.coreCalls)).params.keys, ["y"])
    }))

  it.effect("clears the buttons when the prompt is answered in herdr", () =>
    Effect.gen(function*() {
      const env = yield* setup
      yield* connect(env)
      yield* Queue.offer(env.coreEvents, blocked(2, "approve Edit: src/a.ts"))
      yield* env.take
      yield* Queue.offer(env.coreEvents, { _tag: "status", seq: 3, address: "t1", status: { state: "working" } })
      const edited = yield* env.take
      assert.strictEqual(edited.method, "message.edit")
      assert.strictEqual(edited.params.text, "🔐 Permission: approve Edit: src/a.ts\n→ answered in herdr")
      assert.deepStrictEqual(edited.params.actions, [])
    }))
})

describe("question forms", () => {
  const thread = { kind: "thread", thread: ThreadId.make("thread-✳️main") } as const
  const connect = (env: Effect.Success<typeof setup>) =>
    Effect.gen(function*() {
      yield* Queue.offer(env.coreEvents, { _tag: "snapshot", seq: 1, terminals: [terminal("t1", { template: "claude" })] })
      yield* Queue.offer(env.chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })
      yield* Effect.all([env.take, env.take, env.take])
    })
  const color = { question: "Pick a color", header: "Color", multiSelect: false, options: [{ label: "Red" }, { label: "Green", description: "calm" }] } as const
  const pets = { question: "Pick pets", header: "Pets", multiSelect: true, options: [{ label: "Cat" }, { label: "Dog" }, { label: "Fish" }] } as const
  const ask = (env: Effect.Success<typeof setup>, questions: ReadonlyArray<any>) =>
    Queue.offer(env.hooks, { terminal: "t1", event: "PreToolUse", questions } as any)
  const onScreen = (seq: number): CoreEvent => ({
    _tag: "status",
    seq,
    address: "t1",
    status: { state: "blocked", kind: "question", msg: "answer: Pick a color?", app: "claude-code" }
  })
  const pressed = (action: string): ChatEvent => ({
    _tag: "action.pressed",
    adapter: "discord",
    params: { place: thread, message: MessageId.make("m1"), action: ActionId.make(action) }
  })
  const keys = (env: Effect.Success<typeof setup>) => Queue.take(env.coreCalls).pipe(Effect.map((call) => call.params.keys ?? call.params))

  it.effect("posts a question with its options as buttons; a press types the option's digit", () =>
    Effect.gen(function*() {
      const env = yield* setup
      yield* connect(env)
      yield* ask(env, [color])
      yield* Queue.offer(env.coreEvents, onScreen(2))
      const posted = yield* env.take
      assert.strictEqual(posted.method, "message.post")
      assert.strictEqual(
        posted.params.text,
        "❓ Question · Color\nPick a color\n\n1. **Red**\n2. **Green** — calm\n\n-# Tap one, or write your own answer here."
      )
      assert.deepStrictEqual(posted.params.actions.map((a: any) => [a.id, a.label]), [["q:1:0:0", "Red"], ["q:1:0:1", "Green"]])

      yield* Queue.offer(env.chatEvents, pressed("q:1:0:1"))
      const edited = yield* env.take
      assert.strictEqual(edited.params.text, "❓ Question · Color\nPick a color\n\n1. **Red**\n2. **Green** — calm\n→ Green")
      assert.deepStrictEqual(edited.params.actions, [])
      assert.deepStrictEqual(yield* keys(env), ["2"])
      // One single-select question: the digit submits it; nothing else is typed.
      yield* TestClock.adjust("2 seconds")
      assert.strictEqual(yield* Queue.size(env.coreCalls), 0)
    }))

  it.effect("walks a form of several questions, toggles a multi select, then submits", () =>
    Effect.gen(function*() {
      const env = yield* setup
      yield* connect(env)
      yield* ask(env, [color, pets])
      yield* Queue.offer(env.coreEvents, onScreen(2))
      assert.include((yield* env.take).params.text, "❓ Question 1/2 · Color")
      yield* Queue.offer(env.chatEvents, pressed("q:1:0:0"))
      yield* env.take // the answered question
      assert.deepStrictEqual(yield* keys(env), ["1"])
      const second = yield* env.take
      assert.include(second.params.text, "❓ Question 2/2 · Pets")
      assert.deepStrictEqual(second.params.actions.map((a: any) => a.label), ["Cat", "Dog", "Fish", "Submit ➡"])

      yield* Queue.offer(env.chatEvents, pressed("q:1:1:2"))
      assert.deepStrictEqual(yield* keys(env), ["3"])
      assert.deepStrictEqual((yield* env.take).params.actions.map((a: any) => a.label), ["Cat", "Dog", "✓ Fish", "Submit ➡"])
      yield* Queue.offer(env.chatEvents, pressed("q:1:1:0"))
      yield* keys(env)
      yield* env.take
      yield* Queue.offer(env.chatEvents, pressed("q:1:1:next"))
      assert.include((yield* env.take).params.text, "→ Cat, Fish")
      assert.deepStrictEqual(yield* keys(env), ["tab"])
      yield* TestClock.adjust("1 second")
      assert.deepStrictEqual(yield* keys(env), ["1"]) // the review screen's Submit
    }))

  it.effect("takes the owner's own words: Type something, then the text", () =>
    Effect.gen(function*() {
      const env = yield* setup
      yield* connect(env)
      yield* ask(env, [color])
      yield* Queue.offer(env.coreEvents, onScreen(2))
      yield* env.take
      yield* Queue.offer(env.chatEvents, {
        _tag: "message.received",
        adapter: "discord",
        params: { place: thread, message: MessageId.make("m9"), text: "whatever you recommend", attachments: [] }
      })
      assert.include((yield* env.take).params.text, "→ whatever you recommend")
      assert.deepStrictEqual(yield* keys(env), ["3"])
      yield* TestClock.adjust("1 second")
      assert.deepStrictEqual(yield* Queue.take(env.coreCalls), {
        method: "terminal.send",
        params: { terminal: "t1", text: "whatever you recommend", force: true }
      })
    }))

  it.effect("picks an option with a preview by its digit, then Enter; words close such a form", () =>
    Effect.gen(function*() {
      const env = yield* setup
      yield* connect(env)
      const layout = { ...color, preview: true }
      yield* ask(env, [layout])
      yield* Queue.offer(env.coreEvents, onScreen(2))
      assert.include((yield* env.take).params.text, "-# Tap one. Or write here instead (that closes the form).")
      yield* Queue.offer(env.chatEvents, pressed("q:1:0:1"))
      assert.include((yield* env.take).params.text, "→ Green")
      assert.deepStrictEqual(yield* keys(env), ["2"]) // moves the cursor only
      yield* TestClock.adjust("1 second")
      assert.deepStrictEqual(yield* keys(env), ["enter"])

    }))

  it.effect("closes a form with previews when the owner writes: no Type something there", () =>
    Effect.gen(function*() {
      const env = yield* setup
      yield* connect(env)
      yield* ask(env, [{ ...color, preview: true }])
      yield* Queue.offer(env.coreEvents, onScreen(2))
      yield* env.take
      yield* Queue.offer(env.chatEvents, {
        _tag: "message.received",
        adapter: "discord",
        params: { place: thread, message: MessageId.make("m9"), text: "neither, a grid", attachments: [] }
      })
      assert.include((yield* env.take).params.text, "→ closed; your message went to the agent")
      assert.deepStrictEqual(yield* keys(env), ["esc"])
      yield* TestClock.adjust("1 second")
      assert.deepStrictEqual(yield* Queue.take(env.coreCalls), {
        method: "terminal.send",
        params: { terminal: "t1", text: "neither, a grid", force: true }
      })
    }))

  it.effect("waits a moment for the hook's copy; without one it posts the plain status", () =>
    Effect.gen(function*() {
      const env = yield* setup
      yield* connect(env)
      // The status first, the hook a moment later: still a form.
      yield* Queue.offer(env.coreEvents, onScreen(2))
      yield* Effect.yieldNow
      yield* ask(env, [color])
      assert.include((yield* env.take).params.text, "❓ Question · Color")
      yield* TestClock.adjust("2 seconds")
      // Answered in herdr: the buttons go.
      yield* Queue.offer(env.coreEvents, { _tag: "status", seq: 3, address: "t1", status: { state: "working", app: "claude-code" } })
      const closed = yield* env.take
      assert.include(closed.params.text, "→ answered in herdr")
      assert.deepStrictEqual(closed.params.actions, [])

      // No hook copy at all (another agent): the plain status after the grace.
      yield* Queue.offer(env.coreEvents, onScreen(4))
      for (let i = 0; i < 4; i++) yield* TestClock.adjust("500 millis")
      assert.strictEqual((yield* env.take).params.text, "⚠️ Needs you (question): answer: Pick a color?")
    }))
})

describe("closed tabs and deleted threads", () => {
  const twoSpaces = {
    spaces: [
      layout.spaces[0]!,
      { id: "sp2", name: "web", folder: "/p/web", tabs: [{ id: "tb3", name: "ui", root: { type: "block", id: "p3", content: { terminal: "t3" } } }] }
    ]
  }

  const start = Effect.gen(function*() {
    const env = yield* setup
    env.docs.set("herdr-app", { value: twoSpaces, version: 1 })
    yield* Queue.offer(env.coreEvents, { _tag: "snapshot", seq: 1, terminals: [terminal("t1", { template: "claude" })] })
    yield* Queue.offer(env.chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })
    yield* Effect.all(Array.from({ length: 5 }, () => env.take)) // 2 rooms, 3 threads
    yield* Effect.yieldNow
    return env
  })

  const relayout = (env: Effect.Success<typeof setup>, value: unknown, version: number) =>
    Effect.gen(function*() {
      env.docs.set("herdr-app", { value, version })
      yield* Queue.offer(env.coreEvents, { _tag: "doc", seq: version, name: "herdr-app", version })
    })

  const drain = (env: Effect.Success<typeof setup>) =>
    Effect.gen(function*() {
      yield* Effect.yieldNow
      const calls = []
      while ((yield* Queue.size(env.calls)) > 0) calls.push(yield* env.take)
      return calls
    })

  it.effect("archives the threads of closed tabs, deletes the room of a closed space, and sweeps after a week", () =>
    Effect.gen(function*() {
      const env = yield* start
      // Close tab tb2 ("Shell Tab") and the whole space sp2.
      yield* relayout(env, { spaces: [{ ...layout.spaces[0]!, tabs: [layout.spaces[0]!.tabs[0]!] }] }, 2)
      yield* env.take // room.ensure api
      yield* env.take // thread.ensure main
      const calls = yield* drain(env)
      assert.deepStrictEqual(calls.map((c) => [c.method, c.params]), [
        ["room.ensure", { name: "📦 archive" }],
        ["thread.ensure", { room: "room-📦 archive", thread: "thread-Shell Tab", topic: "closed in herdr; deleted after 7 days" }],
        ["room.ensure", { name: "📦 archive", room: "room-📦 archive" }],
        ["thread.ensure", { room: "room-📦 archive", thread: "thread-ui", topic: "closed in herdr; deleted after 7 days" }],
        ["room.delete", { room: "room-web" }]
      ])
      const saved = (env.docs.get(Store.docName)?.value as Store.State).adapters.discord!
      assert.deepStrictEqual(Object.keys(saved.threads), ["tb1"])
      assert.deepStrictEqual(Object.keys(saved.rooms), ["sp1"])
      assert.deepStrictEqual(Object.keys(saved.archive?.threads ?? {}).sort(), ["thread-Shell Tab", "thread-ui"])

      yield* TestClock.adjust("8 days")
      const swept = yield* drain(env)
      assert.deepStrictEqual(swept.map((c) => [c.method, c.params.thread]).sort(), [
        ["thread.delete", "thread-Shell Tab"],
        ["thread.delete", "thread-ui"]
      ])
      const after = (env.docs.get(Store.docName)?.value as Store.State).adapters.discord!
      assert.deepStrictEqual(after.archive?.threads, {})
    }))

  it.effect("archives nothing when the layout comes back empty", () =>
    Effect.gen(function*() {
      const env = yield* start
      yield* relayout(env, { spaces: [] }, 2)
      const calls = yield* drain(env)
      assert.deepStrictEqual(calls, [])
      const saved = (env.docs.get(Store.docName)?.value as Store.State).adapters.discord!
      assert.deepStrictEqual(Object.keys(saved.threads).sort(), ["tb1", "tb2", "tb3"])
    }))

  it.effect("closes the tab when the owner deletes its thread", () =>
    Effect.gen(function*() {
      const env = yield* start
      yield* Queue.offer(env.chatEvents, { _tag: "thread.deleted", adapter: "discord", params: { thread: ThreadId.make("thread-ui") } })
      assert.strictEqual(yield* Queue.take(env.closedTabs), "tb3")
      const saved = (env.docs.get(Store.docName)?.value as Store.State).adapters.discord!
      assert.isUndefined(saved.threads.tb3)

      // A thread the bridge does not know: nothing happens.
      yield* Queue.offer(env.chatEvents, { _tag: "thread.deleted", adapter: "discord", params: { thread: ThreadId.make("not-ours") } })
      yield* Effect.yieldNow
      assert.strictEqual(yield* Queue.size(env.closedTabs), 0)
    }))
})

describe("new tabs from the platform and commands", () => {
  const start = Effect.gen(function*() {
    const env = yield* setup
    yield* Queue.offer(env.coreEvents, { _tag: "snapshot", seq: 1, terminals: [terminal("t1", { template: "claude" })] })
    yield* Queue.offer(env.chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })
    yield* Effect.all([env.take, env.take, env.take])
    yield* Effect.yieldNow
    return env
  })
  const created = (name: string, room = "room-api", thread = "th-new"): ChatEvent => ({
    _tag: "thread.created",
    adapter: "discord",
    params: { room: RoomId.make(room), thread: ThreadId.make(thread), name }
  })

  it.effect("opens a tab when the name starts with an agent's emoji", () =>
    Effect.gen(function*() {
      const env = yield* start
      yield* Queue.offer(env.chatEvents, created("✳api"))
      yield* untilTab(env)
      assert.deepStrictEqual(yield* Queue.take(env.appCalls), {
        method: "tab.new",
        params: { space: "sp1", name: "api", folder: "/p/api", argv: ["claude"] }
      })
      const posted = yield* env.take
      assert.strictEqual(posted.params.text, "✳️ claude is starting in api / api.")
      const saved = (env.docs.get(Store.docName)?.value as Store.State).adapters.discord!
      assert.deepStrictEqual(saved.threads["tb-new"], { thread: "th-new", emoji: "✳️" })
    }))

  it.effect("makes a message written with the new thread its agent's first task", () =>
    Effect.gen(function*() {
      const env = yield* start
      const message = (text: string, id: string, thread = "th-new"): ChatEvent => ({
        _tag: "message.received",
        adapter: "discord",
        params: { place: { kind: "thread", thread: ThreadId.make(thread) }, message: MessageId.make(id), text, attachments: [] }
      })
      yield* Queue.offer(env.chatEvents, created("✳️fix"))
      yield* Queue.offer(env.chatEvents, message("fix the login form", "u1"))
      assert.deepStrictEqual((yield* env.take).params, {
        place: { kind: "thread", thread: "th-new" },
        message: "u1",
        emoji: { kind: "unicode", value: "👀" }
      })
      yield* TestClock.adjust("2 seconds")
      assert.deepStrictEqual((yield* Queue.take(env.appCalls)).params, {
        space: "sp1",
        name: "fix",
        folder: "/p/api",
        argv: ["claude"],
        task: "fix the login form"
      })

      // While the bot asks who works there, messages wait too.
      yield* Queue.offer(env.chatEvents, created("notes", "room-api", "th-2"))
      yield* env.take // the "starting" post of the first tab
      const ask = yield* env.take
      assert.strictEqual(ask.params.text, "Who works here?")
      yield* Queue.offer(env.chatEvents, message("write it down", "u2", "th-2"))
      yield* env.take // 👀
      yield* Queue.offer(env.chatEvents, {
        _tag: "action.pressed",
        adapter: "discord",
        params: { place: { kind: "thread", thread: ThreadId.make("th-2") }, message: MessageId.make("q1"), action: ActionId.make("newtab:1:shell") }
      })
      yield* env.take // the edited question
      assert.strictEqual((yield* Queue.take(env.appCalls)).params.task, "write it down")
    }))

  it.effect("asks who works here, then opens the tab with the chosen agent", () =>
    Effect.gen(function*() {
      const env = yield* start
      yield* Queue.offer(env.chatEvents, created("notes"))
      const ask = yield* env.take
      assert.strictEqual(ask.method, "ask")
      assert.deepStrictEqual(ask.params.choices.map((c: any) => [c.id, c.label]), [["newtab:1:claude", "claude"], ["newtab:1:shell", "shell"]])

      yield* Queue.offer(env.chatEvents, {
        _tag: "action.pressed",
        adapter: "discord",
        params: { place: { kind: "thread", thread: ThreadId.make("th-new") }, message: MessageId.make("q1"), action: ActionId.make("newtab:1:shell") }
      })
      const edited = yield* env.take
      assert.strictEqual(edited.params.text, "Who works here? → 🐚 shell")
      assert.deepStrictEqual((yield* Queue.take(env.appCalls)).params.argv, ["zsh", "-l"])
    }))

  it.effect("ignores threads outside its rooms and its own threads", () =>
    Effect.gen(function*() {
      const env = yield* start
      yield* Queue.offer(env.chatEvents, created("✳️x", "someone-elses-category"))
      yield* Queue.offer(env.chatEvents, created("✳️main", "room-api", "thread-✳️main"))
      yield* Effect.yieldNow
      assert.strictEqual(yield* Queue.size(env.appCalls), 0)
      assert.strictEqual(yield* Queue.size(env.calls), 0)
    }))

  it.effect("answers /screen, /status and /space new", () =>
    Effect.gen(function*() {
      const env = yield* start
      const command = (command: string, args: Record<string, string> = {}, thread = "thread-✳️main") =>
        Effect.gen(function*() {
          const reply = yield* Deferred.make<{ text: string }, any>()
          yield* Queue.offer(env.chatEvents, {
            _tag: "command.invoked",
            adapter: "discord",
            params: { place: { kind: "thread", thread: ThreadId.make(thread) }, command, args },
            reply
          })
          return (yield* Deferred.await(reply)).text
        })
      assert.strictEqual(yield* command("screen"), "```\nline 1\nˋˋˋcodeˋˋˋ\n$ ready\n```")
      assert.strictEqual(yield* command("status"), "**api**\n  main — ✳️ live\n  Shell Tab — ▫️ gone")
      assert.include(yield* command("space new", { name: "web", folder: "~/p/web", agent: "claude", task: "hi" }), "being made")
      assert.deepStrictEqual(yield* Queue.take(env.appCalls), {
        method: "space.new",
        params: { name: "web", folder: `${process.env.HOME}/p/web`, tab: "claude", argv: ["claude"], task: "hi" }
      })
    }))
})

describe("adapters that drive herdr (protocol for programs)", () => {
  const start = (extra: Partial<typeof capabilities> & { status?: boolean } = {}) =>
    Effect.gen(function*() {
      const env = yield* setup
      yield* Queue.offer(env.coreEvents, {
        _tag: "snapshot",
        seq: 1,
        terminals: [terminal("t1", { template: "claude", status: { state: "idle", app: "claude-code" } })]
      })
      yield* Queue.offer(env.chatEvents, {
        _tag: "adapter.connected",
        adapter: "pipe",
        info: { name: "pipe", version: "0" },
        capabilities: { ...capabilities, ...extra }
      })
      yield* Effect.all([env.take, env.take, env.take])
      yield* Effect.yieldNow
      return env
    })

  it.effect("opens a tab at once with the adapter's agent and task", () =>
    Effect.gen(function*() {
      const env = yield* start()
      yield* Queue.offer(env.chatEvents, {
        _tag: "thread.created",
        adapter: "pipe",
        params: { room: RoomId.make("room-api"), thread: ThreadId.make("th-spec"), name: "spec", agent: "claude", task: "write the spec" }
      })
      assert.deepStrictEqual(yield* Queue.take(env.appCalls), {
        method: "tab.new",
        params: { space: "sp1", name: "spec", folder: "/p/api", argv: ["claude"], task: "write the spec" }
      })
      // No "is starting" post: the program asked for that agent itself (the next post is the refusal below).

      yield* Queue.offer(env.chatEvents, {
        _tag: "thread.created",
        adapter: "pipe",
        params: { room: RoomId.make("room-api"), thread: ThreadId.make("th-x"), name: "x", agent: "nobody" }
      })
      assert.strictEqual((yield* env.take).params.text, "⚠️ No agent named nobody here; the agents are claude, shell.")
      assert.strictEqual(yield* Queue.size(env.appCalls), 0)
    }))

  it.effect("makes a space with its room and first thread, linked for the sync", () =>
    Effect.gen(function*() {
      const env = yield* start()
      const create = (params: any) =>
        Effect.gen(function*() {
          const reply = yield* Deferred.make<any, any>()
          yield* Queue.offer(env.chatEvents, { _tag: "space.create", adapter: "pipe", params, reply })
          return yield* Deferred.await(reply).pipe(Effect.result)
        })
      const made = yield* create({ name: "SD-1234", folder: "~/wt/sd1234", agent: "claude", tab: "spec", task: "read the ticket" })
      assert.deepStrictEqual((yield* Queue.take(env.appCalls)).params, {
        name: "SD-1234",
        folder: `${process.env.HOME}/wt/sd1234`,
        tab: "spec",
        argv: ["claude"],
        task: "read the ticket"
      })
      assert.deepStrictEqual(yield* env.take, { method: "room.ensure", params: { name: "SD-1234" } })
      assert.deepStrictEqual(yield* env.take, {
        method: "thread.ensure",
        params: { room: "room-SD-1234", name: "✳️spec", topic: `SD-1234 / spec — ${process.env.HOME}/wt/sd1234` }
      })
      assert.deepStrictEqual(made, Result.succeed({ room: "room-SD-1234", thread: "thread-✳️spec" }))
      const saved = (env.docs.get(Store.docName)?.value as Store.State).adapters.pipe!
      assert.strictEqual(saved.rooms["sp-new"], "room-SD-1234")
      assert.deepStrictEqual(saved.threads["tb-first"], { thread: "thread-✳️spec", emoji: "✳️" })

      const refused = yield* create({ name: "x", folder: "/x", agent: "nobody" })
      assert.isTrue(Result.isFailure(refused) && refused.failure.code === -32602)
    }))

  it.effect("closes the space when the owner deletes its room", () =>
    Effect.gen(function*() {
      const env = yield* start()
      yield* Queue.offer(env.chatEvents, { _tag: "room.deleted", adapter: "pipe", params: { room: RoomId.make("room-api") } })
      assert.deepStrictEqual(yield* Queue.take(env.appCalls), { method: "space.close", params: { id: "sp1" } })
      yield* Queue.offer(env.chatEvents, { _tag: "room.deleted", adapter: "pipe", params: { room: RoomId.make("not-ours") } })
      yield* Effect.yieldNow
      assert.strictEqual(yield* Queue.size(env.appCalls), 0)
    }))

  it.effect("sends agents' states as data to an adapter that asks for them", () =>
    Effect.gen(function*() {
      const env = yield* start({ status: true })
      // On connect: the current state of every agent in its threads.
      assert.deepStrictEqual(yield* env.take, {
        method: "thread.status",
        params: { thread: "thread-✳️main", terminal: "t1", state: "idle" }
      })
      yield* Queue.offer(env.coreEvents, { _tag: "status", seq: 2, address: "t1", status: { state: "working", app: "claude-code" } })
      assert.deepStrictEqual((yield* env.take).params.state, "working")
      yield* Queue.offer(env.coreEvents, {
        _tag: "status",
        seq: 3,
        address: "t1",
        status: { state: "blocked", app: "claude-code", kind: "auth", msg: "Sign in" }
      })
      assert.deepStrictEqual(yield* env.take, {
        method: "thread.status",
        params: { thread: "thread-✳️main", terminal: "t1", state: "blocked", kind: "auth", text: "Sign in" }
      })
      yield* env.take // "⚠️ Needs you" for the chat side
      yield* Queue.offer(env.coreEvents, { _tag: "removed", seq: 4, address: "t1" })
      assert.deepStrictEqual((yield* env.take).params.state, "gone")
    }))
})

describe("the control room (direct conversation)", () => {
  const direct = { kind: "direct" as const }
  it.effect("turns a message into a task: asks where, then opens a tab with it", () =>
    Effect.gen(function*() {
      const env = yield* setup
      yield* Queue.offer(env.coreEvents, { _tag: "snapshot", seq: 1, terminals: [] })
      yield* Queue.offer(env.chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })
      yield* Effect.all([env.take, env.take, env.take])

      yield* Queue.offer(env.chatEvents, {
        _tag: "message.received",
        adapter: "discord",
        params: { place: direct, message: MessageId.make("d1"), text: "🐚 Run the nightly backup check", attachments: [] }
      })
      const ask = yield* env.take
      assert.strictEqual(ask.method, "ask")
      assert.strictEqual(ask.params.text, "🐚 shell, where?")
      assert.deepStrictEqual(ask.params.choices, [{ id: "task:1:sp1", label: "api" }])

      yield* Queue.offer(env.chatEvents, {
        _tag: "action.pressed",
        adapter: "discord",
        params: { place: direct, message: MessageId.make("q1"), action: ActionId.make("task:1:sp1") }
      })
      assert.deepStrictEqual(yield* Queue.take(env.appCalls), {
        method: "tab.new",
        params: { space: "sp1", name: "run-the-nightly", folder: "/p/api", argv: ["zsh", "-l"], task: "Run the nightly backup check" }
      })
      assert.strictEqual((yield* env.take).params.text, "🐚 shell, where?\n→ started in api / run-the-nightly; follow it in its channel.")

      // "help" gets the help text.
      yield* Queue.offer(env.chatEvents, {
        _tag: "message.received",
        adapter: "discord",
        params: { place: direct, message: MessageId.make("d2"), text: "help", attachments: [] }
      })
      assert.include((yield* env.take).params.text, "control room")
    }))
})

describe("dashboard", () => {
  it.effect("posts one status message in the direct conversation, then edits it as agents change", () =>
    Effect.gen(function*() {
      const env = yield* setupWith({ dashboardEvery: "10 seconds" })
      yield* Queue.offer(env.coreEvents, { _tag: "snapshot", seq: 1, terminals: [terminal("t1", { template: "claude" })] })
      yield* Queue.offer(env.chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })
      yield* Effect.all([env.take, env.take, env.take])

      yield* TestClock.adjust("10 seconds")
      const posted = yield* env.take
      assert.strictEqual(posted.method, "message.post")
      assert.deepStrictEqual(posted.params.place, { kind: "direct" })
      assert.isTrue(posted.params.text.startsWith("**api**\n  main — ✳️ live"))
      yield* Effect.yieldNow
      assert.strictEqual((env.docs.get(Store.docName)?.value as Store.State).adapters.discord!.dashboard, "m1")

      // A layout change syncs the threads; the dashboard is still that message.
      yield* Queue.offer(env.coreEvents, { _tag: "doc", seq: 2, name: "herdr-app", version: 1 })
      yield* Effect.all([env.take, env.take, env.take])
      yield* Effect.yieldNow
      assert.strictEqual((env.docs.get(Store.docName)?.value as Store.State).adapters.discord!.dashboard, "m1")

      yield* Queue.offer(env.coreEvents, {
        _tag: "status",
        seq: 2,
        address: "t1",
        status: { state: "working", msg: "Running tests" }
      })
      yield* TestClock.adjust("10 seconds")
      const edited = yield* env.take
      assert.strictEqual(edited.method, "message.edit")
      assert.strictEqual(edited.params.message, "m1")
      assert.include(edited.params.text, "main — ✳️ ⏳ working: Running tests")

      // Nothing changed: no edit.
      yield* TestClock.adjust("30 seconds")
      assert.strictEqual(yield* Queue.size(env.calls), 0)
    }))
})

describe("dashboard off", () => {
  it.effect("posts no live status; an old one says so once and is forgotten", () =>
    Effect.gen(function*() {
      const env = yield* setupWith({ dashboardEvery: "10 seconds", withoutDashboard: ["discord"] })
      env.docs.set(Store.docName, { value: { adapters: { discord: { rooms: {}, threads: {}, dashboard: "old" } } }, version: 1 })
      yield* Queue.offer(env.coreEvents, { _tag: "snapshot", seq: 1, terminals: [terminal("t1", { template: "claude" })] })
      yield* Queue.offer(env.chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })
      yield* Effect.all([env.take, env.take, env.take])
      yield* TestClock.adjust("10 seconds")
      const edited = yield* env.take
      assert.deepStrictEqual([edited.method, edited.params.message, edited.params.text], [
        "message.edit",
        "old",
        "The live status is off here; `/status` shows it."
      ])
      yield* Queue.offer(env.coreEvents, { _tag: "status", seq: 2, address: "t1", status: { state: "idle" } })
      yield* TestClock.adjust("30 seconds")
      yield* Effect.yieldNow
      assert.strictEqual((env.docs.get(Store.docName)?.value as Store.State).adapters.discord!.dashboard, undefined)
      const left: Array<{ method: string; params: any }> = []
      for (let next = yield* Queue.poll(env.calls); next._tag === "Some"; next = yield* Queue.poll(env.calls)) left.push(next.value)
      assert.isFalse(left.some((call) => call.params?.place?.kind === "direct"))
    }))
})

describe("split tabs", () => {
  const split = {
    spaces: [{
      id: "sp1",
      name: "api",
      folder: "/p/api",
      tabs: [{
        id: "tb1",
        name: "main",
        root: {
          type: "row",
          id: "tb1",
          children: [
            { type: "block", id: "p1", content: { terminal: "t1" } },
            { type: "block", id: "p2", content: { terminal: "t2" } }
          ]
        }
      }]
    }]
  }
  const start = Effect.gen(function*() {
    const env = yield* setup
    env.docs.set("herdr-app", { value: split, version: 1 })
    yield* Queue.offer(env.coreEvents, {
      _tag: "snapshot",
      seq: 1,
      terminals: [
        terminal("t1", { template: "claude" }),
        terminal("t2", { foreground: { pid: 2, name: "zsh", argv: ["zsh", "-l"], cwd: "/" } })
      ]
    })
    yield* Queue.offer(env.chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })
    yield* Effect.all([env.take, env.take]) // room, thread
    yield* Effect.yieldNow
    return env
  })
  const place = { kind: "thread" as const, thread: ThreadId.make("thread-✳️main") }
  const message = (text: string, replyTo?: string): ChatEvent => ({
    _tag: "message.received",
    adapter: "discord",
    params: {
      place,
      message: MessageId.make("o1"),
      text,
      attachments: [],
      ...(replyTo === undefined ? {} : { replyTo: MessageId.make(replyTo) })
    }
  })

  it.effect("asks who a plain message is for, then sends it there", () =>
    Effect.gen(function*() {
      const env = yield* start
      yield* Queue.offer(env.chatEvents, message("run the tests"))
      const ask = yield* env.take
      assert.strictEqual(ask.params.text, "Who is this for?")
      assert.deepStrictEqual(ask.params.choices, [
        { id: "send:1:t1", label: "✳️ claude" },
        { id: "send:1:t2", label: "🐚 shell" }
      ])
      yield* Queue.offer(env.chatEvents, {
        _tag: "action.pressed",
        adapter: "discord",
        params: { place, message: MessageId.make("q1"), action: ActionId.make("send:1:t2") }
      })
      assert.strictEqual((yield* env.take).params.text, "Who is this for? → 🐚 shell")
      assert.deepStrictEqual(yield* Queue.take(env.coreCalls), {
        method: "terminal.send",
        params: { terminal: "t2", text: "run the tests" }
      })
      const seen = yield* env.take
      assert.deepStrictEqual([seen.method, seen.params.message], ["react", "o1"])
    }))

  it.effect("signs the panes' messages, and a reply goes back to the pane that wrote it", () =>
    Effect.gen(function*() {
      const env = yield* start
      yield* Queue.offer(env.hooks, { terminal: "t1", event: "Stop", text: "All green." })
      const posted = yield* env.take
      assert.strictEqual(posted.params.text, "✳️ claude · All green.")
      yield* Queue.offer(env.chatEvents, message("now commit", "m1")) // the fake chat names every post m1
      assert.deepStrictEqual((yield* Queue.take(env.coreCalls)).params, { terminal: "t1", text: "now commit" })
    }))

  it.effect("sends to the agent named by a leading emoji, without the emoji", () =>
    Effect.gen(function*() {
      const env = yield* start
      yield* Queue.offer(env.chatEvents, message("🐚 ls -la"))
      assert.deepStrictEqual((yield* Queue.take(env.coreCalls)).params, { terminal: "t2", text: "ls -la" })
    }))
})

describe("attachments", () => {
  it.live("puts a screenshot beside the agent and tells it where", () =>
    Effect.gen(function*() {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
      const server = createServer((_, response) => response.end(png))
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          server.listen(0, "127.0.0.1", () => resume(Effect.void))
        }),
        () => Effect.sync(() => server.close())
      )
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/image.png`

      const env = yield* setup
      yield* Queue.offer(env.coreEvents, { _tag: "snapshot", seq: 1, terminals: [terminal("t1", { template: "claude" })] })
      yield* Queue.offer(env.chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })
      yield* Effect.all([env.take, env.take, env.take])
      yield* Queue.offer(env.chatEvents, {
        _tag: "message.received",
        adapter: "discord",
        params: {
          place: { kind: "thread", thread: ThreadId.make("thread-✳️main") },
          message: MessageId.make("o1"),
          text: "",
          attachments: [{ name: "image.png", url, size: png.length, contentType: "image/png" }]
        }
      })
      const put = yield* Queue.take(env.coreCalls)
      assert.strictEqual(put.method, "terminal.put")
      assert.deepStrictEqual([put.params.terminal, put.params.name], ["t1", "image.png"])
      assert.deepStrictEqual(Buffer.from(put.params.data, "base64"), png)
      assert.deepStrictEqual((yield* Queue.take(env.coreCalls)).params, {
        terminal: "t1",
        text: "[file: /state/files/t1/image.png]"
      })
    }).pipe(Effect.scoped))

  it.live("refuses files over 8 MB without downloading them", () =>
    Effect.gen(function*() {
      const env = yield* setup
      yield* Queue.offer(env.coreEvents, { _tag: "snapshot", seq: 1, terminals: [terminal("t1", { template: "claude" })] })
      yield* Queue.offer(env.chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })
      yield* Effect.all([env.take, env.take, env.take])
      yield* Queue.offer(env.chatEvents, {
        _tag: "message.received",
        adapter: "discord",
        params: {
          place: { kind: "thread", thread: ThreadId.make("thread-✳️main") },
          message: MessageId.make("o1"),
          text: "look",
          attachments: [{ name: "big.mov", url: "http://127.0.0.1:9/never", size: 9 * 1024 * 1024 }]
        }
      })
      assert.deepStrictEqual((yield* Queue.take(env.coreCalls)).params, {
        terminal: "t1",
        text: "look\n[file: big.mov: too large (max 8 MB)]"
      })
    }).pipe(Effect.scoped))
})

describe("files from the agent", () => {
  const replyWith = (adapterCapabilities: typeof capabilities, text: (path: string) => string) =>
    Effect.gen(function*() {
      const folder = mkdtempSync(join(tmpdir(), "herdr-link-"))
      const path = join(folder, "chart.png")
      writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const env = yield* setup
      yield* Queue.offer(env.coreEvents, { _tag: "snapshot", seq: 1, terminals: [terminal("t1", { template: "claude" })] })
      yield* Queue.offer(env.chatEvents, {
        _tag: "adapter.connected",
        adapter: "discord",
        info: { name: "d", version: "0" },
        capabilities: adapterCapabilities
      })
      yield* Effect.all([env.take, env.take, env.take])
      yield* Queue.offer(env.hooks, { terminal: "t1", event: "Stop", text: text(path) })
      return { posted: (yield* env.take).params, path }
    })

  it.live("sends the files a reply names, and says which could not go", () =>
    Effect.gen(function*() {
      const { posted, path } = yield* replyWith(capabilities, (path) => `Here it is.\n[file: ${path}]\n[file: /no/such.png]`)
      assert.strictEqual(posted.text, "Here it is.\n📎 /no/such.png: no such file")
      assert.deepStrictEqual(posted.files, [{ path, name: "chart.png" }])
    }).pipe(Effect.scoped))

  it.live("gives an adapter that takes no files the paths, and a reply of files only a line", () =>
    Effect.gen(function*() {
      const { posted, path } = yield* replyWith({ ...capabilities, files: false }, (path) => `[file: ${path}]`)
      assert.strictEqual(posted.text, `📎 chart.png\n📎 \`${path}\``)
      assert.isUndefined(posted.files)
    }).pipe(Effect.scoped))
})

describe("adapters without rooms", () => {
  it.effect("makes top-level threads named after space and tab, and deletes them when the tab closes", () =>
    Effect.gen(function*() {
      const env = yield* setup
      yield* Queue.offer(env.coreEvents, { _tag: "snapshot", seq: 1, terminals: [terminal("t1", { template: "claude" })] })
      yield* Queue.offer(env.chatEvents, {
        _tag: "adapter.connected",
        adapter: "plain",
        info: { name: "plain", version: "0" },
        capabilities: { ...capabilities, rooms: false }
      })
      const first = yield* env.take
      assert.deepStrictEqual([first.method, first.params.name, first.params.room], ["thread.ensure", "✳️api / main", undefined])
      yield* env.take
      env.docs.set("herdr-app", { value: { spaces: [{ ...layout.spaces[0]!, tabs: [layout.spaces[0]!.tabs[0]!] }] }, version: 2 })
      yield* Queue.offer(env.coreEvents, { _tag: "doc", seq: 2, name: "herdr-app", version: 2 })
      yield* env.take // the remaining tab
      assert.deepStrictEqual(yield* env.take, { method: "thread.delete", params: { thread: "thread-api / Shell Tab" } })
    }))

  const startPlain = Effect.gen(function*() {
    const env = yield* setup
    yield* Queue.offer(env.coreEvents, { _tag: "snapshot", seq: 1, terminals: [terminal("t1", { template: "claude" })] })
    yield* Queue.offer(env.chatEvents, {
      _tag: "adapter.connected",
      adapter: "plain",
      info: { name: "plain", version: "0" },
      capabilities: { ...capabilities, rooms: false }
    })
    yield* Effect.all([env.take, env.take])
    yield* Effect.yieldNow
    return env
  })
  const createdPlain = (name: string): ChatEvent => ({
    _tag: "thread.created",
    adapter: "plain",
    params: { thread: ThreadId.make("th-new"), name }
  })

  it.effect("opens a tab from a new thread named `✳️space / tab`", () =>
    Effect.gen(function*() {
      const env = yield* startPlain
      yield* Queue.offer(env.chatEvents, createdPlain("✳️ API / fix login"))
      yield* untilTab(env)
      assert.deepStrictEqual((yield* Queue.take(env.appCalls)).params, {
        space: "sp1",
        name: "fix login",
        folder: "/p/api",
        argv: ["claude"]
      })
    }))

  it.effect("asks which space for a new thread that names none, then who works there", () =>
    Effect.gen(function*() {
      const env = yield* startPlain
      yield* Queue.offer(env.chatEvents, createdPlain("notes"))
      const where = yield* env.take
      assert.strictEqual(where.params.text, "Which space?")
      assert.deepStrictEqual(where.params.choices.map((c: any) => [c.id, c.label]), [["newtab:1@sp1", "api"]])
      const press = (action: string): ChatEvent => ({
        _tag: "action.pressed",
        adapter: "plain",
        params: { place: { kind: "thread", thread: ThreadId.make("th-new") }, message: MessageId.make("q1"), action: ActionId.make(action) }
      })
      yield* Queue.offer(env.chatEvents, press("newtab:1@sp1"))
      assert.strictEqual((yield* env.take).params.text, "Which space? → api")
      const who = yield* env.take
      assert.strictEqual(who.params.text, "Who works here?")
      yield* Queue.offer(env.chatEvents, press("newtab:2:shell"))
      yield* env.take // the edited question
      assert.deepStrictEqual((yield* Queue.take(env.appCalls)).params, {
        space: "sp1",
        name: "notes",
        folder: "/p/api",
        argv: ["zsh", "-l"]
      })
    }))
})

describe("machines", () => {
  it.effect("adds this computer's name, or the herdr machine of a remote space, to room names", () =>
    Effect.gen(function*() {
      const env = yield* setupWith({ machine: "laptop" })
      env.docs.set("herdr-app", {
        value: {
          spaces: [
            { ...layout.spaces[0]!, tabs: [] },
            { id: "sp2", name: "api", folder: "/srv/api", machine: "build-box", tabs: [] }
          ]
        },
        version: 1
      })
      yield* Queue.offer(env.coreEvents, { _tag: "snapshot", seq: 1, terminals: [] })
      yield* Queue.offer(env.chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })
      assert.strictEqual((yield* env.take).params.name, "api · laptop")
      assert.strictEqual((yield* env.take).params.name, "api · build-box")
    }))

  it.effect("keeps a separate archive per computer", () =>
    Effect.gen(function*() {
      const env = yield* setupWith({ machine: "laptop" })
      yield* Queue.offer(env.coreEvents, { _tag: "snapshot", seq: 1, terminals: [] })
      yield* Queue.offer(env.chatEvents, { _tag: "adapter.connected", adapter: "discord", info: { name: "d", version: "0" }, capabilities })
      yield* Effect.all([env.take, env.take, env.take])
      env.docs.set("herdr-app", { value: { spaces: [{ ...layout.spaces[0]!, tabs: [layout.spaces[0]!.tabs[0]!] }] }, version: 2 })
      yield* Queue.offer(env.coreEvents, { _tag: "doc", seq: 2, name: "herdr-app", version: 2 })
      yield* Effect.all([env.take, env.take]) // room and the remaining thread
      assert.deepStrictEqual((yield* env.take).params, { name: "📦 archive · laptop" })
    }))
})

describe("slug", () => {
  it("names a tab after the task's first words", () => {
    assert.strictEqual(Bridge.slug("Fix the flaky login test, please"), "fix-the-flaky")
    assert.strictEqual(Bridge.slug("Перевір логи"), "перевір-логи")
    assert.strictEqual(Bridge.slug("!!!"), "task")
  })
})

describe("agentOf", () => {
  it("matches by template, then reported app, then program", () => {
    assert.strictEqual(Bridge.agentOf(agents, terminal("t", { template: "claude" })), "claude")
    assert.strictEqual(
      Bridge.agentOf(agents, terminal("t", { status: { state: "idle", app: "claude-code" } })),
      "claude"
    )
    assert.strictEqual(
      Bridge.agentOf(agents, terminal("t", { foreground: { pid: 1, name: "zsh", argv: ["/bin/zsh"], cwd: "/" } })),
      "shell"
    )
    assert.isUndefined(Bridge.agentOf(agents, terminal("t")))
  })
})
