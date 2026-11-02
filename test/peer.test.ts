import { assert, describe, it } from "@effect/vitest"
import { type Cause, Effect, Fiber, Queue, Stream } from "effect"
import { MessageId, ThreadId } from "../src/protocol/Chat.ts"
import { ErrorCode } from "../src/protocol/JsonRpc.ts"
import { AdapterToBridge, BridgeToAdapter } from "../src/protocol/Methods.ts"
import * as Peer from "../src/protocol/Peer.ts"
import * as Transport from "../src/protocol/Transport.ts"

const capabilities = {
  rooms: true,
  direct: true,
  threadCreation: true,
  actions: true,
  reactions: true,
  customEmoji: true,
  commands: true,
  edit: true,
  files: true,
  maxText: 2000,
  maxActions: 25
}

const notImplemented = () => Effect.fail(new Peer.RpcError({ code: ErrorCode.Unsupported, message: "no" }))

/** An adapter that answers hello and records what the bridge posts. */
const fakeAdapter = (transport: Transport.Transport, posted: Queue.Queue<string>) =>
  Peer.make({
    transport,
    outgoing: AdapterToBridge,
    incoming: BridgeToAdapter,
    handlers: () => ({
      hello: () => Effect.succeed({ protocol: 1 as const, adapter: { name: "fake", version: "0" }, capabilities }),
      "room.ensure": notImplemented,
      "thread.ensure": notImplemented,
      "message.post": ({ text }) => Queue.offer(posted, text).pipe(Effect.as({ message: MessageId.make("m1") })),
      "message.edit": notImplemented,
      react: () => Effect.die("boom"),
      ask: notImplemented,
      "thread.delete": notImplemented,
      "room.delete": notImplemented
    })
  })

const bridge = (
  transport: Transport.Transport,
  received: Queue.Queue<string>
) =>
  Peer.make({
    transport,
    outgoing: BridgeToAdapter,
    incoming: AdapterToBridge,
    handlers: (peer) => ({
      "thread.created": ({ name }) => Queue.offer(received, `created ${name}`),
      "thread.deleted": () => Effect.void,
      // Calls back into the adapter from inside a handler: must not deadlock.
      "message.received": ({ text, place }) =>
        Queue.offer(received, `got ${text}`).pipe(
          Effect.andThen(peer.request("message.post", { place, text: `echo ${text}` })),
          Effect.orDie,
          Effect.asVoid
        ),
      "reaction.added": () => Effect.void,
      "action.pressed": () => Effect.void,
      "command.invoked": ({ command }) => Effect.succeed({ text: `ran ${command}` })
    })
  })

const setup = Effect.gen(function*() {
  const [bridgeSide, adapterSide] = yield* Transport.pair
  const posted = yield* Queue.unbounded<string>()
  const received = yield* Queue.unbounded<string>()
  const adapter = yield* fakeAdapter(adapterSide, posted)
  const core = yield* bridge(bridgeSide, received)
  return { adapter, core, posted, received }
})

const place = { kind: "thread" as const, thread: ThreadId.make("t1") }

describe("Peer", () => {
  it.effect("does the hello handshake", () =>
    Effect.gen(function*() {
      const { core } = yield* setup
      const hello = yield* core.request("hello", { protocol: 1, config: {}, commands: [] })
      assert.strictEqual(hello.adapter.name, "fake")
      assert.strictEqual(hello.capabilities.maxText, 2000)
    }))

  it.effect("serves requests in both directions, handlers may call back", () =>
    Effect.gen(function*() {
      const { adapter, core, posted, received } = yield* setup
      yield* adapter.notify("message.received", { place, message: MessageId.make("1"), text: "hi", attachments: [] })
      assert.strictEqual(yield* Queue.take(received), "got hi")
      assert.strictEqual(yield* Queue.take(posted), "echo hi")

      const reply = yield* adapter.request("command.invoked", { place, command: "screen", args: {} })
      assert.strictEqual(reply.text, "ran screen")
      assert.isDefined(core)
    }))

  it.effect("keeps notification order", () =>
    Effect.gen(function*() {
      const { adapter, received } = yield* setup
      for (const name of ["a", "b", "c", "d"]) {
        yield* adapter.notify("thread.created", { thread: ThreadId.make(name), name })
      }
      const got = yield* Effect.all(Array.from({ length: 4 }, () => Queue.take(received)))
      assert.deepStrictEqual(got, ["created a", "created b", "created c", "created d"])
    }))

  it.effect("returns handler errors and defects as JSON-RPC errors", () =>
    Effect.gen(function*() {
      const { core } = yield* setup
      const unsupported = yield* core.request("room.ensure", { name: "x" }).pipe(Effect.flip)
      assert.strictEqual(unsupported._tag, "RpcError")
      assert.strictEqual((unsupported as Peer.RpcError).code, ErrorCode.Unsupported)

      const died = yield* core
        .request("react", { place, message: MessageId.make("1"), emoji: { kind: "unicode", value: "👍" } })
        .pipe(Effect.flip)
      assert.strictEqual((died as Peer.RpcError).code, ErrorCode.InternalError)
    }))

  it.effect("rejects invalid params and unknown methods", () =>
    Effect.gen(function*() {
      const [bridgeSide, adapterSide] = yield* Transport.pair
      yield* fakeAdapter(adapterSide, yield* Queue.unbounded<string>())
      const lines = yield* Queue.unbounded<string>()
      yield* bridgeSide.incoming.pipe(Stream.runForEach((line) => Queue.offer(lines, line)), Effect.forkScoped)

      yield* bridgeSide.send(`{"jsonrpc":"2.0","id":1,"method":"room.ensure","params":{"name":""}}`)
      assert.strictEqual(JSON.parse(yield* Queue.take(lines)).error.code, ErrorCode.InvalidParams)

      yield* bridgeSide.send(`{"jsonrpc":"2.0","id":2,"method":"nope"}`)
      assert.strictEqual(JSON.parse(yield* Queue.take(lines)).error.code, ErrorCode.MethodNotFound)

      yield* bridgeSide.send(`{"jsonrpc":"2.0","id":3,"method":"thread.created","params":{}}`)
      assert.strictEqual(JSON.parse(yield* Queue.take(lines)).error.code, ErrorCode.MethodNotFound)

      yield* bridgeSide.send(`garbage`)
      assert.strictEqual(JSON.parse(yield* Queue.take(lines)).error.code, ErrorCode.InvalidRequest)
    }))

  it.effect("fails pending requests when the other side goes away", () =>
    Effect.gen(function*() {
      const inbox = yield* Queue.unbounded<string, Cause.Done>()
      const sent = yield* Queue.unbounded<string>()
      const transport: Transport.Transport = {
        incoming: Stream.fromQueue(inbox),
        send: (line) => Queue.offer(sent, line).pipe(Effect.asVoid)
      }
      const core = yield* bridge(transport, yield* Queue.unbounded<string>())
      const pending = yield* core.request("hello", { protocol: 1, config: {}, commands: [] }).pipe(Effect.forkScoped)
      yield* Queue.take(sent) // the request went out, now the adapter exits
      yield* Queue.end(inbox)

      const error = yield* Fiber.join(pending).pipe(Effect.flip)
      assert.strictEqual(error._tag, "PeerClosed")
      assert.strictEqual((yield* core.closed)._tag, "PeerClosed")
      const late = yield* core.request("hello", { protocol: 1, config: {}, commands: [] }).pipe(Effect.flip)
      assert.strictEqual(late._tag, "PeerClosed")
    }))
})
