/**
 * A line transport over a unix socket (the hc socket). The connection lives
 * as long as the surrounding scope.
 */
import { NodeSocket } from "@effect/platform-node"
import { Duration, Effect, Stream } from "effect"
import { lines, type Transport, TransportError } from "./Transport.ts"

const encoder = new TextEncoder()

export const connect = Effect.fnUntraced(function*(path: string, options?: { readonly openTimeout?: Duration.Input }) {
  const socket = yield* NodeSocket.makeNet({ path, openTimeout: options?.openTimeout ?? Duration.seconds(5) })
  const reader = yield* socket.reader.pipe(
    Effect.mapError((error) => new TransportError({ message: `cannot connect to ${path}: ${error.message}`, cause: error }))
  )
  const writer = yield* socket.writer
  const bytes = Stream.fromEffectRepeat(reader.pull).pipe(
    Stream.flattenIterable,
    Stream.map((chunk) => (typeof chunk === "string" ? encoder.encode(chunk) : chunk))
  )
  const transport: Transport = {
    incoming: lines(bytes).pipe(
      Stream.mapError((error) => new TransportError({ message: error.message, cause: error }))
    ),
    send: (line) =>
      writer.write(`${line}\n`).pipe(
        Effect.mapError((error) => new TransportError({ message: error.message, cause: error }))
      )
  }
  return transport
})
