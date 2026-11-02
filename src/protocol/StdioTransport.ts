/**
 * The adapter side of the Chat protocol: lines on this process's stdin and
 * stdout. Nothing else may write to stdout, so `guardStdout` sends stray
 * console.log output to stderr.
 */
import { Effect, Stream } from "effect"
import { lines, type Transport, TransportError } from "./Transport.ts"

export const guardStdout = () => {
  console.log = console.error
  console.info = console.error
  console.debug = console.error
}

export const make = (): Transport => ({
  incoming: lines(
    Stream.fromAsyncIterable(
      process.stdin as AsyncIterable<Uint8Array>,
      (cause) => new TransportError({ message: "stdin failed", cause })
    )
  ),
  send: (line) =>
    Effect.callback<void, TransportError>((resume) => {
      process.stdout.write(`${line}\n`, (error) =>
        resume(error ? Effect.fail(new TransportError({ message: "stdout failed", cause: error })) : Effect.void))
    })
})
