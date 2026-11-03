/**
 * The Chat port: what the bridge core sees of all adapters together. It never
 * names a platform; adapters are addressed by their config name.
 */
import { Context, type Deferred, Schema, type Effect, type Stream } from "effect"
import type { AdapterInfo, Capabilities } from "../protocol/Chat.ts"
import type { AdapterToBridge, BridgeToAdapter, Params, Result } from "../protocol/Methods.ts"
import type { NotificationName, PeerClosed, RequestName, RpcError } from "../protocol/Peer.ts"

/** Something the owner did, as reported by an adapter. */
export type OwnerEvent = {
  readonly [K in NotificationName<AdapterToBridge>]: {
    readonly _tag: K
    readonly adapter: string
    readonly params: Params<AdapterToBridge[K]>
  }
}[NotificationName<AdapterToBridge>]

/** A command waiting for its reply; the adapter gives up if none comes in time. */
export interface CommandEvent {
  readonly _tag: "command.invoked"
  readonly adapter: string
  readonly params: Params<AdapterToBridge["command.invoked"]>
  readonly reply: Deferred.Deferred<Result<AdapterToBridge["command.invoked"]>, RpcError>
}

/** An adapter finished `hello` (first start or restart): time to sync its rooms. */
export interface AdapterConnected {
  readonly _tag: "adapter.connected"
  readonly adapter: string
  readonly info: AdapterInfo
  readonly capabilities: Capabilities
}

export interface AdapterDisconnected {
  readonly _tag: "adapter.disconnected"
  readonly adapter: string
  readonly reason: string
}

export type ChatEvent = OwnerEvent | CommandEvent | AdapterConnected | AdapterDisconnected

export interface ConnectedAdapter {
  readonly name: string
  readonly info: AdapterInfo
  readonly capabilities: Capabilities
}

/** One configured adapter as the status file shows it. */
export interface AdapterState {
  readonly name: string
  readonly connected: boolean
  /** Why it is not connected (it is restarting, or stopped for good). */
  readonly error?: string
}

/** The adapter is unknown, not connected yet, or restarting. */
export class AdapterUnavailable extends Schema.TaggedError<AdapterUnavailable>()("AdapterUnavailable", {
  adapter: Schema.String
}) {}

export type ChatError = RpcError | PeerClosed | AdapterUnavailable

export class Chat extends Context.Service<Chat, {
  readonly connected: Effect.Effect<ReadonlyArray<ConnectedAdapter>>
  /** Every started adapter: connected, or its last error. */
  readonly states: Effect.Effect<ReadonlyArray<AdapterState>>
  readonly call: <K extends RequestName<BridgeToAdapter>>(
    adapter: string,
    method: K,
    params: Params<BridgeToAdapter[K]>
  ) => Effect.Effect<Result<BridgeToAdapter[K]>, ChatError>
  /** Single consumer: the bridge core. */
  readonly events: Stream.Stream<ChatEvent>
}>()("herdr-link/chat/Chat") {}
