/** Prints the Chat protocol as OpenRPC: `pnpm schema > schema/chat.openrpc.json`. */
import * as OpenRpc from "./protocol/OpenRpc.ts"

process.stdout.write(`${JSON.stringify(OpenRpc.make(), null, 2)}\n`)
