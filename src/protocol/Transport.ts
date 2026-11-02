/**
 * A line transport: what a Peer needs from stdin/stdout, a socket or a test.
 */
import { type Cause, Effect, Queue, Schema, Stream } from "effect"

export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

export interface Transport {
  /** Incoming lines without the trailing newline. Ends when the other side closes. */
  readonly incoming: Stream.Stream<string, TransportError>
  /** Sends one line; the transport adds the newline. */
  readonly send: (line: string) => Effect.Effect<void, TransportError>
}

/** Splits a byte stream into lines, skipping blank ones. */
export const lines = <E>(bytes: Stream.Stream<Uint8Array, E>): Stream.Stream<string, E> =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim() !== "")
  )

/**
 * Two transports wired to each other, for tests and in-process adapters.
 * Closing the scope ends both directions.
 */
export const pair = Effect.gen(function*() {
  const aToB = yield* Queue.unbounded<string, Cause.Done>()
  const bToA = yield* Queue.unbounded<string, Cause.Done>()
  yield* Effect.addFinalizer(() => Effect.all([Queue.end(aToB), Queue.end(bToA)]))
  const make = (inbox: Queue.Queue<string, Cause.Done>, outbox: Queue.Queue<string, Cause.Done>): Transport => ({
    incoming: Stream.fromQueue(inbox),
    send: (line) =>
      Queue.offer(outbox, line).pipe(
        Effect.flatMap((accepted) =>
          accepted ? Effect.void : Effect.fail(new TransportError({ message: "transport closed" }))
        )
      )
  })
  return [make(bToA, aToB), make(aToB, bToA)] as const
})

