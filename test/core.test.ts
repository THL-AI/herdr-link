import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Queue, Scope, Stream } from "effect"
import { make } from "../src/core/HerdrCore.ts"
import * as Spaces from "../src/core/Spaces.ts"
import { CoreMethods, CoreNotifications, type Terminal } from "../src/core/Methods.ts"
import * as Peer from "../src/protocol/Peer.ts"
import * as Transport from "../src/protocol/Transport.ts"

const terminal = (address: string): Terminal => ({
  address,
  labels: { "herdr.space": "sp1", "herdr.tab": "tb1" },
  argv: ["claude"],
  cwd: "/tmp",
  state: "live",
  created_ms: 0
})

const notFound = (message: string) => new Peer.RpcError({ code: -32000, message, data: { kind: "not_found" } })
const unused = () => Effect.die("not used in this test")

interface Connection {
  readonly peer: Peer.Peer<typeof CoreNotifications>
  /** The core hangs up. */
  readonly close: Effect.Effect<void>
}

/** A fake herdr-core: every connection is handed to the test so it can push events or hang up. */
const fakeCore = Effect.gen(function*() {
  const connections = yield* Queue.unbounded<Connection>()
  let seq = 10
  const terminals = [terminal("t1")]

  const connect = Effect.gen(function*() {
    const scope = yield* Scope.make()
    const [client, server] = yield* Transport.pair.pipe(Scope.provide(scope))
    const peer = yield* Peer.make({
      transport: server,
      outgoing: CoreNotifications,
      incoming: CoreMethods,
      handlers: () => ({
        hello: () =>
          Effect.succeed({
            generation: 1,
            version: "test",
            core: { id: "c", name: "fake" },
            methods: [],
            features: []
          }),
        "terminal.list": () => Effect.succeed({ terminals }),
        "terminal.get": ({ terminal: address }) =>
          address === "t1" ? Effect.succeed(terminal("t1")) : Effect.fail(notFound(`no terminal "${address}"`)),
        "terminal.run": unused,
        "terminal.send": unused,
        "terminal.keys": unused,
        "terminal.interrupt": unused,
        "terminal.read": unused,
        "terminal.put": unused,
        "terminal.kill": unused,
        "templates.list": unused,
        "doc.get": unused,
        "doc.set": unused,
        "events.subscribe": () => Effect.succeed({ seq: seq++, terminals })
      })
    }).pipe(Scope.provide(scope))
    yield* Queue.offer(connections, { peer, close: Scope.close(scope, Exit.void) })
    return client
  })

  return { connect, connections }
})

describe("HerdrCore", () => {
  it.live("maps core errors to their kind and reconnects after the core restarts", () =>
    Effect.gen(function*() {
      const fake = yield* fakeCore
      const core = yield* make(fake.connect)

      const t1 = yield* core.call("terminal.get", { terminal: "t1" })
      assert.strictEqual(t1.address, "t1")
      const error = yield* core.call("terminal.get", { terminal: "t9" }).pipe(Effect.flip)
      assert.strictEqual(error.kind, "not_found")

      const first = yield* Queue.take(fake.connections)
      yield* first.close
      const list = yield* core.call("terminal.list", {})
      assert.strictEqual(list.terminals.length, 1)
      assert.strictEqual(yield* Queue.size(fake.connections), 1) // a second connection was opened
    }))

  it.live("streams a snapshot, then events, and starts over after a disconnect or `missed`", () =>
    Effect.gen(function*() {
      const fake = yield* fakeCore
      const core = yield* make(fake.connect)
      const events = yield* Queue.unbounded<string>()
      yield* core.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event._tag === "snapshot" ? `snapshot ${event.seq}` : event._tag)),
        Effect.forkScoped
      )

      assert.strictEqual(yield* Queue.take(events), "snapshot 10")
      const first = yield* Queue.take(fake.connections)
      yield* first.peer.notify("event", { seq: 11, type: "status", terminal: "t1", data: { status: { state: "done" } } })
      yield* first.peer.notify("event", { seq: 12, type: "lost", terminal: "t1", data: {} })
      yield* first.peer.notify("event", { seq: 13, type: "title", terminal: "t1", data: { wrong: 1 } })
      assert.deepStrictEqual(yield* Effect.all([Queue.take(events), Queue.take(events), Queue.take(events)]), [
        "status",
        "other",
        "other"
      ])

      yield* first.close
      assert.strictEqual(yield* Queue.take(events), "snapshot 11")

      const second = yield* Queue.take(fake.connections)
      yield* second.peer.notify("missed", {})
      assert.strictEqual(yield* Queue.take(events), "snapshot 12")
    }))
})

describe("Spaces", () => {
  it.effect("reads spaces, tabs and their terminals from the herdr-app document", () =>
    Effect.gen(function*() {
      const spaces = yield* Spaces.decode({
        spaces: [
          {
            id: "sp1",
            name: "",
            folder: process.env.HOME,
            tabs: [{
              id: "tb1",
              name: "general",
              root: {
                type: "row",
                id: "tb1",
                children: [
                  { type: "block", id: "p1", content: { terminal: "t1" } },
                  { type: "row", id: "r2", children: [{ type: "block", id: "p2", content: { terminal: "t4" } }] }
                ]
              }
            }]
          },
          { id: "sp2", name: "", folder: "/Users/x/Projects/api", tabs: [] },
          { id: "sp3", name: "web", folder: "/Users/x/Projects/web", tabs: [] }
        ]
      })
      assert.deepStrictEqual(spaces.map((s) => s.name), ["~", "api", "web"])
      assert.deepStrictEqual(spaces[0]!.tabs[0]!.terminals, ["t1", "t4"])
      assert.deepStrictEqual(yield* Spaces.decode(null), [])
    }))
})
