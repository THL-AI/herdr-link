import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { readFile } from "node:fs/promises"
import { ThreadId } from "../src/protocol/Chat.ts"
import * as JsonRpc from "../src/protocol/JsonRpc.ts"
import { AdapterToBridge, BridgeToAdapter } from "../src/protocol/Methods.ts"
import * as OpenRpc from "../src/protocol/OpenRpc.ts"

const decodeLine = Schema.decodeUnknownExit(JsonRpc.MessageFromLine)

const decodeLineSync = (line: string) => {
  const exit = decodeLine(line)
  assert.isTrue(Exit.isSuccess(exit), `expected ${line} to decode`)
  return Exit.isSuccess(exit) ? exit.value : undefined
}

describe("JsonRpc", () => {
  it("tells requests, notifications, successes and failures apart", () => {
    const request = decodeLineSync(`{"jsonrpc":"2.0","id":1,"method":"react","params":{}}`)
    assert.deepStrictEqual(request, { jsonrpc: "2.0", id: 1, method: "react", params: {} })

    const notification = decodeLineSync(`{"jsonrpc":"2.0","method":"thread.deleted","params":{"thread":"1"}}`)
    assert.isFalse(notification !== undefined && "id" in notification)

    const failure = decodeLineSync(`{"jsonrpc":"2.0","id":"a","error":{"code":-32601,"message":"nope"}}`)
    assert.isTrue(failure !== undefined && "error" in failure)

    const success = decodeLineSync(`{"jsonrpc":"2.0","id":"a","result":{"message":"9"}}`)
    assert.deepStrictEqual(success, { jsonrpc: "2.0", id: "a", result: { message: "9" } })
  })

  it("rejects garbage", () => {
    for (const line of [`not json`, `{"id":1,"method":"x"}`, `{"jsonrpc":"1.0","id":1,"method":"x"}`, `[]`]) {
      assert.isTrue(Exit.isFailure(decodeLine(line)), line)
    }
  })
})

describe("Chat methods", () => {
  it.effect("decodes message.received and ignores unknown keys", () =>
    Effect.gen(function*() {
      const params = yield* Schema.decodeUnknownEffect(AdapterToBridge["message.received"].params)({
        place: { kind: "thread", thread: "123" },
        message: "456",
        text: "hi",
        attachments: [{ name: "a.png", url: "https://cdn/a.png", size: 10 }],
        future: true
      })
      assert.deepStrictEqual(params.place, { kind: "thread", thread: ThreadId.make("123") })
      assert.isFalse("future" in params)
    }))

  it("rejects empty ids and unknown places", () => {
    const decode = Schema.decodeUnknownExit(BridgeToAdapter.react.params)
    const emoji = { kind: "unicode", value: "👍" }
    assert.isTrue(Exit.isSuccess(decode({ place: { kind: "direct" }, message: "1", emoji })))
    assert.isTrue(Exit.isFailure(decode({ place: { kind: "direct" }, message: "", emoji })))
    assert.isTrue(Exit.isFailure(decode({ place: { kind: "channel", thread: "1" }, message: "1", emoji })))
  })

  it("validates command names in hello", () => {
    const decode = Schema.decodeUnknownExit(BridgeToAdapter.hello.params)
    const hello = (name: string) => ({
      protocol: 1,
      config: { guild: "1" },
      commands: [{ name, description: "d", options: [] }]
    })
    assert.isTrue(Exit.isSuccess(decode(hello("space new"))))
    assert.isTrue(Exit.isFailure(decode(hello("Space"))))
    assert.isTrue(Exit.isFailure(decode(hello("a b c d"))))
    assert.isTrue(Exit.isSuccess(decode({ ...hello("space new"), agents: [{ name: "claude", emoji: "✳️" }] })))
    assert.isTrue(Exit.isFailure(decode({ ...hello("space new"), agents: [{ name: "", emoji: "✳️" }] })))
  })

  it("keeps method names in sync with their table keys", () => {
    for (const [key, def] of [...Object.entries(BridgeToAdapter), ...Object.entries(AdapterToBridge)]) {
      assert.strictEqual(def.method, key)
    }
  })
})

describe("OpenRpc", () => {
  it("matches the committed schema/chat.openrpc.json (run `pnpm schema`)", async () => {
    const committed = JSON.parse(await readFile(new URL("../schema/chat.openrpc.json", import.meta.url), "utf8"))
    assert.deepStrictEqual(committed, OpenRpc.make())
  })

  it("resolves every $ref", () => {
    const document = OpenRpc.make()
    const text = JSON.stringify(document)
    const schemas = (document.components as { schemas: Record<string, unknown> }).schemas
    for (const [, ref] of text.matchAll(/"\$ref":"([^"]+)"/g)) {
      if (ref!.startsWith("#/components/tags/")) continue
      const name = ref!.replace("#/components/schemas/", "")
      assert.isTrue(name in schemas, ref)
    }
  })
})
