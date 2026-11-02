/**
 * The Core port: a client of herdr-core over its unix socket.
 *
 * Requests share one connection, opened on first use, dropped after a minute
 * idle and reopened when the core restarts. Subscriptions need their own
 * connection (in plain mode a subscribed connection carries only
 * notifications), so every run of `events` opens one: a snapshot first, then
 * events; after a disconnect, a `missed` or a silent core it reconnects and
 * starts over with a fresh snapshot. Consumers rebuild their state from each
 * snapshot.
 */
import { type Cause, Context, Duration, Effect, Layer, Predicate, Queue, RcRef, Schedule, Schema, type Scope, Stream } from "effect"
import * as Peer from "../protocol/Peer.ts"
import type { Params, Result } from "../protocol/Rpc.ts"
import * as SocketTransport from "../protocol/SocketTransport.ts"
import type { Transport } from "../protocol/Transport.ts"
import { type CoreEvent, decodeEvent } from "./Events.ts"
import { CoreMethods, CoreNotifications, Generation } from "./Methods.ts"

export class CoreError extends Schema.TaggedError<CoreError>()("CoreError", {
  method: Schema.String,
  /** herdr-core's `data.kind` (`not_found`, `finished`, `conflict`, ...), or `unavailable`. */
  kind: Schema.String,
  message: Schema.String
}) {}

export class HerdrCore extends Context.Service<HerdrCore, {
  readonly call: <K extends Peer.RequestName<CoreMethods>>(
    method: K,
    params: Params<CoreMethods[K]>
  ) => Effect.Effect<Result<CoreMethods[K]>, CoreError>
  /** Snapshot, then changes; a new snapshot after every reconnect. Never ends. */
  readonly events: Stream.Stream<CoreEvent>
}>()("herdr-link/core/HerdrCore") {}

/** Default socket: `$HC_TERMINAL_SOCKET` inside herdr terminals, else the per-user path. */
export const defaultSocket = () =>
  process.env.HC_TERMINAL_SOCKET ??
    `${process.env.HOME ?? ""}/.local/state/herdr-core/default/default.sock`

const idleTimeToLive = Duration.minutes(1)
const silenceLimit = Duration.seconds(45) // heartbeats come every 15 s
const resubscribeSchedule = Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("15 seconds")])

const toCoreError = (method: string) => (error: Peer.RpcError | Peer.PeerClosed | CoreError): CoreError => {
  switch (error._tag) {
    case "CoreError":
      return error
    case "PeerClosed":
      return new CoreError({ method, kind: "unavailable", message: error.message })
    case "RpcError": {
      const data = error.data
      const kind = Predicate.hasProperty(data, "kind") && Predicate.isString(data.kind) ? data.kind : "rpc"
      return new CoreError({ method, kind, message: error.message })
    }
  }
}

/**
 * Opens a connection and does `hello`. `onNotification` receives what the core
 * pushes on a subscribed connection.
 */
const open = Effect.fnUntraced(function*(
  connectTransport: Effect.Effect<Transport, CoreError, Scope.Scope>,
  onNotification: (message: { readonly method: keyof CoreNotifications; readonly params: unknown }) => Effect.Effect<void>
) {
  const transport = yield* connectTransport
  const peer = yield* Peer.make({
    transport,
    outgoing: CoreMethods,
    incoming: CoreNotifications,
    handlers: () => ({
      event: (params) => onNotification({ method: "event", params }),
      heartbeat: (params) => onNotification({ method: "heartbeat", params }),
      missed: (params) => onNotification({ method: "missed", params })
    })
  })
  const hello = yield* peer.request("hello", { generation: Generation }).pipe(Effect.mapError(toCoreError("hello")))
  if (hello.generation !== Generation) {
    return yield* new CoreError({
      method: "hello",
      kind: "unsupported_generation",
      message: `herdr-core ${hello.version} speaks generation ${hello.generation}, the bridge ${Generation}`
    })
  }
  return peer
})

export const make = Effect.fnUntraced(function*(connectTransport: Effect.Effect<Transport, CoreError, Scope.Scope>) {
  const requests = yield* RcRef.make({
    acquire: open(connectTransport, () => Effect.void),
    idleTimeToLive
  })

  const callOnce = <K extends Peer.RequestName<CoreMethods>>(method: K, params: Params<CoreMethods[K]>) =>
    RcRef.get(requests).pipe(
      Effect.flatMap((peer) => peer.request(method, params)),
      Effect.scoped,
      Effect.mapError(toCoreError(method))
    )

  const call = <K extends Peer.RequestName<CoreMethods>>(method: K, params: Params<CoreMethods[K]>) =>
    callOnce(method, params).pipe(
      // A stale connection (the core restarted): reopen once.
      Effect.catchIf(
        (error) => error.kind === "unavailable",
        () => RcRef.invalidate(requests).pipe(Effect.andThen(callOnce(method, params)))
      )
    )

  const subscribeOnce: Stream.Stream<CoreEvent, CoreError> = Stream.unwrap(
    Effect.gen(function*() {
      const queue = yield* Queue.unbounded<CoreEvent, CoreError | Cause.Done>()
      let lastHeard = Date.now()
      const peer = yield* open(connectTransport, ({ method, params }) =>
        Effect.gen(function*() {
          lastHeard = Date.now()
          if (method === "missed") {
            yield* Effect.logWarning("herdr-core says we fell behind; resubscribing")
            yield* Queue.end(queue)
          } else if (method === "event") {
            const event = yield* decodeEvent(params as Params<CoreNotifications["event"]>)
            yield* Queue.offer(queue, event)
          }
        }))
      const snapshot = yield* peer.request("events.subscribe", {}).pipe(Effect.mapError(toCoreError("events.subscribe")))
      lastHeard = Date.now()

      yield* peer.closed.pipe(
        Effect.flatMap((closed) =>
          Queue.fail(queue, new CoreError({ method: "events.subscribe", kind: "unavailable", message: closed.message }))
        ),
        Effect.forkScoped
      )
      yield* Effect.sleep(silenceLimit).pipe(
        Effect.andThen(Effect.suspend(() =>
          Date.now() - lastHeard > Duration.toMillis(silenceLimit)
            ? Queue.fail(queue, new CoreError({ method: "events.subscribe", kind: "unavailable", message: "no heartbeat" }))
            : Effect.void
        )),
        Effect.forever,
        Effect.forkScoped
      )

      const first: CoreEvent = { _tag: "snapshot", seq: snapshot.seq, terminals: snapshot.terminals }
      return Stream.concat(Stream.succeed(first), Stream.fromQueue(queue))
    })
  )

  const events = subscribeOnce.pipe(
    // A normal end (after `missed`) is a reason to resubscribe too.
    Stream.concat(Stream.fail(new CoreError({ method: "events.subscribe", kind: "resubscribe", message: "missed" }))),
    Stream.tapError((error) =>
      error.kind === "resubscribe" ? Effect.void : Effect.logWarning(`herdr-core events: ${error.message}; reconnecting`)
    ),
    Stream.retry(resubscribeSchedule),
    Stream.catch(() => Stream.empty) // the schedule never gives up; this only satisfies the types
  )

  return HerdrCore.of({ call, events })
})

export const layer = (socket: string = defaultSocket()): Layer.Layer<HerdrCore> =>
  Layer.effect(
    HerdrCore,
    make(
      SocketTransport.connect(socket).pipe(
        Effect.mapError((error) => new CoreError({ method: "connect", kind: "unavailable", message: error.message }))
      )
    )
  )
