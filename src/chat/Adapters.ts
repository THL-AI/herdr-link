/**
 * The Chat port backed by adapter processes: one per `[adapters.*]` section,
 * each restarted with backoff when it exits or fails to start.
 */
import { Deferred, Duration, Effect, Layer, Queue, Schedule, Stream } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import * as Commands from "../bridge/Commands.ts"
import { type AdapterSection, BridgeConfig, enabledAdapters } from "../Config.ts"
import type { CommandSpec } from "../protocol/Chat.ts"
import { ErrorCode } from "../protocol/JsonRpc.ts"
import type { AdapterToBridge, BridgeToAdapter, Params, Result } from "../protocol/Methods.ts"
import { type Handlers, RpcError } from "../protocol/Peer.ts"
import { AdapterFailed, type Connection, connect } from "./AdapterProcess.ts"
import { AdapterUnavailable, Chat, type ChatError, type ChatEvent, type OwnerEvent } from "./Chat.ts"

/** How long the bridge waits for one call to an adapter. */
const defaultCallTimeout = Duration.seconds(30)

/** How long an adapter waits for the core to answer a command. */
const commandTimeout = Duration.minutes(1)

const restartSchedule = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("1 minute")]).pipe(
  Schedule.jittered,
  Schedule.setInputType<AdapterFailed>(),
  Schedule.while(({ input }) => !input.fatal)
)

export const make = Effect.fnUntraced(function*(options: {
  readonly adapters: Readonly<Record<string, AdapterSection>>
  readonly commands: ReadonlyArray<CommandSpec>
  /** How long one call may take before it fails, so a stuck adapter can't hold the bridge. */
  readonly callTimeout?: Duration.Input
}) {
  const callTimeout = Duration.fromInputUnsafe(options.callTimeout ?? defaultCallTimeout)
  const events = yield* Queue.unbounded<ChatEvent>()
  const connections = new Map<string, Connection>()

  const handlers = (adapter: string): Handlers<typeof AdapterToBridge> => {
    const forward = <E extends OwnerEvent>(tag: E["_tag"]) => (params: E["params"]) =>
      Queue.offer(events, { _tag: tag, adapter, params } as OwnerEvent).pipe(Effect.asVoid)
    return {
      "thread.created": forward("thread.created"),
      "thread.deleted": forward("thread.deleted"),
      "message.received": forward("message.received"),
      "reaction.added": forward("reaction.added"),
      "action.pressed": forward("action.pressed"),
      "command.invoked": (params: Params<typeof AdapterToBridge["command.invoked"]>) =>
        Effect.gen(function*() {
          const reply = yield* Deferred.make<Result<typeof AdapterToBridge["command.invoked"]>, RpcError>()
          yield* Queue.offer(events, { _tag: "command.invoked", adapter, params, reply })
          return yield* Deferred.await(reply).pipe(
            Effect.timeoutOrElse({
              duration: commandTimeout,
              orElse: () =>
                Effect.fail(new RpcError({ code: ErrorCode.InternalError, message: "the bridge did not answer" }))
            })
          )
        })
    }
  }

  const runOnce = (name: string, section: AdapterSection) =>
    Effect.gen(function*() {
      const connection = yield* connect({ name, section, commands: options.commands, handlers: () => handlers(name) })
      connections.set(name, connection)
      yield* Effect.logInfo(`connected: ${connection.info.name} ${connection.info.version}`)
      yield* Queue.offer(events, {
        _tag: "adapter.connected",
        adapter: name,
        info: connection.info,
        capabilities: connection.capabilities
      })
      const closed = yield* connection.peer.closed
      return yield* new AdapterFailed({ adapter: name, message: closed.message, fatal: false })
    }).pipe(
      Effect.scoped,
      Effect.tapError((error) =>
        Effect.gen(function*() {
          if (connections.delete(name)) {
            yield* Queue.offer(events, { _tag: "adapter.disconnected", adapter: name, reason: error.message })
          }
          yield* error.fatal
            ? Effect.logError(`stopped: ${error.message}`)
            : Effect.logWarning(`${error.message}; restarting`)
        })
      )
    )

  for (const [name, section] of Object.entries(options.adapters)) {
    yield* runOnce(name, section).pipe(
      Effect.retry(restartSchedule),
      Effect.ignore,
      Effect.annotateLogs({ adapter: name }),
      Effect.forkScoped
    )
  }

  return Chat.of({
    connected: Effect.sync(() =>
      [...connections.values()].map(({ name, info, capabilities }) => ({ name, info, capabilities }))
    ),
    call: (adapter, method, params) =>
      Effect.suspend((): Effect.Effect<Result<typeof BridgeToAdapter[typeof method]>, ChatError> => {
        const connection = connections.get(adapter)
        return connection === undefined
          ? Effect.fail(new AdapterUnavailable({ adapter }))
          : connection.peer.request(method, params).pipe(
            Effect.timeoutOrElse({
              duration: callTimeout,
              orElse: () =>
                Effect.fail(
                  new RpcError({
                    code: ErrorCode.InternalError,
                    message: `${adapter}: ${method} got no answer in ${Duration.format(callTimeout)}`
                  })
                )
            })
          )
      }),
    events: Stream.fromQueue(events)
  })
})

export const layer: Layer.Layer<Chat, never, BridgeConfig | ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(
  Chat,
  Effect.gen(function*() {
    const config = yield* BridgeConfig
    return yield* make({ adapters: enabledAdapters(config.adapters), commands: Commands.specs(config.agents ?? {}) })
  })
)
