import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { fileURLToPath } from "node:url"
import * as Adapters from "../src/chat/Adapters.ts"
import { connect } from "../src/chat/AdapterProcess.ts"
import type { AdapterSection } from "../src/Config.ts"
import type { AdapterToBridge } from "../src/protocol/Methods.ts"
import type { Handlers } from "../src/protocol/Peer.ts"

const fake = fileURLToPath(new URL("fixtures/fake-adapter.mjs", import.meta.url))
const section = (extra: Record<string, unknown> = {}) =>
  ({ command: [process.execPath, fake], env: ["FAKE_TOKEN"], owner: "1", ...extra }) as AdapterSection
const direct = { kind: "direct" as const }

/** `connect` alone, before any handler could run. */
const noHandlers = () => ({}) as Handlers<typeof AdapterToBridge>

describe("adapter processes", () => {
  it.live("spawns, says hello, routes calls and events, restarts after a crash", () =>
    Effect.gen(function*() {
      process.env.FAKE_TOKEN = "t"
      process.env.OTHER_SECRET = "s"
      const chat = yield* Adapters.make({ adapters: { fake: section() }, commands: [] })
      const events = yield* Stream.toPull(chat.events)
      const take = events.pipe(Effect.map((chunk) => chunk[0]!))

      const connected = yield* take
      assert.strictEqual(connected._tag, "adapter.connected")
      assert.deepStrictEqual((yield* chat.connected).map((a) => a.info.name), ["fake"])

      const posted = yield* chat.call("fake", "message.post", { place: direct, text: "env" })
      assert.strictEqual(posted.message, "1")
      const env = yield* take
      assert.strictEqual(env._tag === "message.received" && env.params.text, "FAKE_TOKEN")

      yield* chat.call("fake", "message.post", { place: direct, text: "config" })
      const config = yield* take
      assert.strictEqual(config._tag === "message.received" && config.params.text, `{"owner":"1"}`)

      yield* chat.call("fake", "message.post", { place: direct, text: "exit" })
      assert.strictEqual((yield* take)._tag, "adapter.disconnected")
      const unavailable = yield* chat.call("fake", "message.post", { place: direct, text: "x" }).pipe(Effect.flip)
      assert.strictEqual(unavailable._tag, "AdapterUnavailable")
      assert.strictEqual((yield* take)._tag, "adapter.connected")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 15_000)

  it.live("fails a call the adapter never answers, and keeps going", () =>
    Effect.gen(function*() {
      const chat = yield* Adapters.make({ adapters: { fake: section() }, commands: [], callTimeout: "300 millis" })
      const events = yield* Stream.toPull(chat.events)
      yield* events // adapter.connected
      const error = yield* chat.call("fake", "message.post", { place: direct, text: "hang" }).pipe(Effect.flip)
      assert.strictEqual(error._tag, "RpcError")
      assert.include(error.message, "got no answer")
      const posted = yield* chat.call("fake", "message.post", { place: direct, text: "after" })
      assert.strictEqual(posted.message, "1")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 15_000)

  it.live("treats a rejected config as fatal", () =>
    Effect.gen(function*() {
      const error = yield* connect({
        name: "fake",
        section: section({ reject: true }),
        commands: [],
        handlers: noHandlers
      }).pipe(Effect.flip)
      assert.isTrue(error.fatal)
      assert.include(error.message, "bad config")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("reports a command that cannot start", () =>
    Effect.gen(function*() {
      const error = yield* connect({
        name: "missing",
        section: { command: ["/nonexistent/adapter"] } as AdapterSection,
        commands: [],
        handlers: noHandlers
      }).pipe(Effect.flip)
      assert.isFalse(error.fatal)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
