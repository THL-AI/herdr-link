/**
 * Receives what the shared agent hook (`hooks/herdr-link-hook.mjs`) sends:
 * one JSON line per connection on a unix socket only the owner can open.
 */
import { Effect, Queue, Schema, Stream } from "effect"
import { chmodSync, mkdirSync, rmSync } from "node:fs"
import { connect, createServer } from "node:net"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const HookMessage = Schema.Struct({
  terminal: Schema.NonEmptyString,
  event: Schema.Literals(["Stop", "StopFailure", "Notification", "PreToolUse"]),
  text: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String)
})
export type HookMessage = typeof HookMessage.Type

export const defaultSocket = () =>
  process.env.HERDR_LINK_SOCKET ?? join(homedir(), ".local/state/herdr-link/hooks.sock")

const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(HookMessage))

export class HookServerError extends Schema.TaggedError<HookServerError>()("HookServerError", {
  path: Schema.String,
  message: Schema.String
}) {}

/** Whether something already answers on this socket (another bridge). */
const inUse = (path: string) =>
  Effect.callback<boolean>((resume) => {
    const probe = connect(path)
    probe.once("connect", () => {
      probe.destroy()
      resume(Effect.succeed(true))
    })
    probe.once("error", () => resume(Effect.succeed(false)))
  })

/**
 * Listens while the scope is open; the stream yields every valid message.
 * Fails if another bridge already listens: one bridge per user.
 */
export const listen = Effect.fnUntraced(function*(path: string) {
  if (yield* inUse(path)) {
    return yield* new HookServerError({ path, message: "another herdr-link is already running" })
  }
  const queue = yield* Queue.unbounded<HookMessage>()
  const offer = (line: string) =>
    decodeLine(line).pipe(
      Effect.flatMap((message) => Queue.offer(queue, message)),
      Effect.catch((error) => Effect.logWarning(`bad hook message: ${error.message}`)),
      Effect.runFork
    )

  yield* Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>, HookServerError>((resume) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      rmSync(path, { force: true }) // a stale socket from a crashed run
      const server = createServer((connection) => {
        let buffer = ""
        connection.setEncoding("utf8")
        connection.setTimeout(5000, () => connection.destroy())
        connection.on("data", (chunk) => {
          buffer += chunk
          if (buffer.length > 256 * 1024) connection.destroy()
        })
        connection.on("end", () => {
          for (const line of buffer.split("\n")) if (line.trim() !== "") offer(line)
        })
        connection.on("error", () => {})
      })
      server.once("error", (error) => resume(Effect.fail(new HookServerError({ path, message: error.message }))))
      server.listen(path, () => {
        chmodSync(path, 0o600)
        resume(Effect.succeed(server))
      })
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void))
        rmSync(path, { force: true })
      })
  )
  yield* Effect.logInfo(`listening for agent hooks on ${path}`)
  return Stream.fromQueue(queue)
})
