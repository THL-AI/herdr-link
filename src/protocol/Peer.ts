/**
 * One end of a JSON-RPC 2.0 connection where both sides send requests and
 * notifications. Typed by two method tables: the methods this side calls
 * (`outgoing`) and the methods it serves (`incoming`).
 *
 * Incoming notifications are handled one at a time in arrival order (a
 * thread must exist before its messages arrive); incoming requests run
 * concurrently. Responses are routed by the reader itself, so a handler may
 * call the other side without deadlocking.
 */
import { Cause, Deferred, Effect, Exit, Queue, Schema, type Scope, Stream } from "effect"
import * as JsonRpc from "./JsonRpc.ts"
import type { MethodDef, NotificationDef, Params, RequestDef, Result } from "./Rpc.ts"
import type { Transport, TransportError } from "./Transport.ts"

/** A JSON-RPC error: returned by the other side, or raised by a handler to answer with it. */
export class RpcError extends Schema.TaggedError<RpcError>()("RpcError", {
  code: Schema.Int,
  message: Schema.String,
  data: Schema.optional(Schema.Json)
}) {}

/** The connection ended (the process exited or closed its stdout). */
export class PeerClosed extends Schema.TaggedError<PeerClosed>()("PeerClosed", {
  message: Schema.String
}) {}

export type Methods = Record<string, MethodDef>

export type RequestName<T extends Methods> = {
  [K in keyof T]: T[K] extends RequestDef<string, any, any> ? K : never
}[keyof T] & string

export type NotificationName<T extends Methods> = {
  [K in keyof T]: T[K] extends NotificationDef<string, any> ? K : never
}[keyof T] & string

export type Handlers<In extends Methods, R = never> = {
  readonly [K in keyof In]: (
    params: Params<In[K]>
  ) => Effect.Effect<In[K] extends RequestDef<string, any, any> ? Result<In[K]> : void, RpcError, R>
}

export interface Peer<Out extends Methods> {
  readonly request: <K extends RequestName<Out>>(
    method: K,
    params: Params<Out[K]>
  ) => Effect.Effect<Result<Out[K]>, RpcError | PeerClosed>
  readonly notify: <K extends NotificationName<Out>>(
    method: K,
    params: Params<Out[K]>
  ) => Effect.Effect<void, PeerClosed>
  /** Succeeds once the transport has ended, with the reason. */
  readonly closed: Effect.Effect<PeerClosed>
}

export const make = Effect.fnUntraced(function*<Out extends Methods, In extends Methods, R = never>(options: {
  readonly transport: Transport
  readonly outgoing: Out
  readonly incoming: In
  /** Receives the peer so handlers can call the other side. */
  readonly handlers: (peer: Peer<Out>) => Handlers<In, R>
}): Effect.fn.Return<Peer<Out>, never, Scope.Scope | R> {
  const { transport, outgoing, incoming } = options
  const pending = new Map<JsonRpc.Id, Deferred.Deferred<unknown, RpcError | PeerClosed>>()
  const closed = yield* Deferred.make<PeerClosed>()
  let closedReason: PeerClosed | undefined
  let nextId = 1

  const send = (message: JsonRpc.Message) =>
    transport.send(JSON.stringify(message)).pipe(
      Effect.mapError((error: TransportError) => new PeerClosed({ message: error.message }))
    )

  const fail = (id: JsonRpc.Id | null, error: RpcError) =>
    send({
      jsonrpc: "2.0",
      id,
      error: error.data === undefined
        ? { code: error.code, message: error.message }
        : { code: error.code, message: error.message, data: error.data }
    })

  const encodeParams = (def: MethodDef, params: unknown) =>
    Schema.encodeUnknownEffect(def.params)(params).pipe(
      Effect.orDie // our own values must match our own schemas
    ) as Effect.Effect<Schema.Json>

  const request = <K extends RequestName<Out>>(method: K, params: Params<Out[K]>) =>
    Effect.suspend(() => {
      if (closedReason !== undefined) return Effect.fail(closedReason)
      const def = outgoing[method] as RequestDef<string, any, any>
      const id = nextId++
      const deferred = Deferred.makeUnsafe<unknown, RpcError | PeerClosed>()
      pending.set(id, deferred)
      return encodeParams(def, params).pipe(
        Effect.flatMap((encoded) => send({ jsonrpc: "2.0", id, method, params: encoded })),
        Effect.andThen(Deferred.await(deferred)),
        Effect.flatMap((raw) =>
          Schema.decodeUnknownEffect(def.result)(raw).pipe(
            Effect.mapError((issue) =>
              new RpcError({ code: JsonRpc.ErrorCode.InternalError, message: `invalid result of ${method}: ${issue}` })
            )
          )
        ),
        Effect.ensuring(Effect.sync(() => pending.delete(id)))
      )
    }) as Effect.Effect<Result<Out[K]>, RpcError | PeerClosed>

  const notify = <K extends NotificationName<Out>>(method: K, params: Params<Out[K]>) =>
    Effect.gen(function*() {
      const encoded = yield* encodeParams(outgoing[method]!, params)
      yield* send({ jsonrpc: "2.0", method, params: encoded })
    })

  const peer: Peer<Out> = { request, notify, closed: Deferred.await(closed) }
  const handlers = options.handlers(peer) as Record<string, (params: unknown) => Effect.Effect<unknown, RpcError, R>>

  const decodeParams = (def: MethodDef, params: unknown) =>
    Schema.decodeUnknownEffect(def.params)(params ?? {}).pipe(
      Effect.mapError((issue) =>
        new RpcError({ code: JsonRpc.ErrorCode.InvalidParams, message: `invalid params of ${def.method}: ${issue}` })
      )
    )

  const lookup = (method: string, tag: MethodDef["_tag"]) => {
    const def = Object.hasOwn(incoming, method) ? incoming[method] : undefined
    return def?._tag === tag ? def : undefined
  }

  const serveRequest = (message: JsonRpc.Request) =>
    Effect.gen(function*() {
      const def = lookup(message.method, "Request") as RequestDef<string, any, any> | undefined
      if (def === undefined) {
        return yield* new RpcError({
          code: JsonRpc.ErrorCode.MethodNotFound,
          message: `unknown method ${message.method}`
        })
      }
      const params = yield* decodeParams(def, message.params)
      const result = yield* handlers[message.method]!(params)
      return yield* Schema.encodeUnknownEffect(def.result)(result).pipe(Effect.orDie)
    }).pipe(
      Effect.catchDefect((defect) =>
        Effect.logError(`handler of ${message.method} died`, defect).pipe(
          Effect.andThen(Effect.fail(new RpcError({ code: JsonRpc.ErrorCode.InternalError, message: "internal error" })))
        )
      ),
      Effect.matchEffect({
        onFailure: (error) => fail(message.id, error),
        onSuccess: (result) => send({ jsonrpc: "2.0", id: message.id, result: result as Schema.Json })
      }),
      Effect.ignore
    )

  const notifications = yield* Queue.unbounded<JsonRpc.Notification>()

  const serveNotification = (message: JsonRpc.Notification) =>
    Effect.gen(function*() {
      const def = lookup(message.method, "Notification")
      if (def === undefined) return yield* Effect.logWarning(`ignoring unknown notification ${message.method}`)
      const params = yield* decodeParams(def, message.params)
      yield* handlers[message.method]!(params)
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError(`notification ${message.method} failed`, cause)
      )
    )

  const route = (line: string) =>
    Effect.gen(function*() {
      const exit = Schema.decodeUnknownExit(JsonRpc.MessageFromLine)(line)
      if (Exit.isFailure(exit)) {
        yield* Effect.logWarning("dropping malformed message", line)
        return yield* fail(
          null,
          new RpcError({ code: JsonRpc.ErrorCode.InvalidRequest, message: "not a JSON-RPC 2.0 message" })
        )
      }
      const message = exit.value
      if ("method" in message) {
        if ("id" in message) yield* Effect.forkScoped(serveRequest(message))
        else yield* Queue.offer(notifications, message)
        return
      }
      const deferred = message.id === null ? undefined : pending.get(message.id)
      if (deferred === undefined) return yield* Effect.logWarning("response to an unknown request", line)
      pending.delete(message.id!)
      yield* "error" in message
        ? Deferred.fail(deferred, new RpcError(message.error))
        : Deferred.succeed(deferred, message.result)
    })

  const shutdown = (reason: string) =>
    Effect.suspend(() => {
      if (closedReason !== undefined) return Effect.void
      const error = closedReason = new PeerClosed({ message: reason })
      const waiting = [...pending.values()]
      pending.clear()
      return Effect.forEach(waiting, (deferred) => Deferred.fail(deferred, error), { discard: true }).pipe(
        Effect.andThen(Deferred.succeed(closed, error))
      )
    })

  yield* Effect.forkScoped(
    Effect.forever(Queue.take(notifications).pipe(Effect.flatMap(serveNotification)))
  )
  yield* transport.incoming.pipe(
    Stream.runForEach((line) => route(line).pipe(Effect.ignore)),
    Effect.matchCauseEffect({
      onSuccess: () => shutdown("connection closed"),
      onFailure: (cause) => shutdown(`connection failed: ${Cause.pretty(cause)}`)
    }),
    Effect.forkScoped
  )
  yield* Effect.addFinalizer(() => shutdown("peer closed"))

  return peer
})
