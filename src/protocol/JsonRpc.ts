/**
 * JSON-RPC 2.0 envelope. One message per line (NDJSON), UTF-8, no batches.
 *
 * Both peers send requests and notifications: the bridge calls the adapter
 * (`room.ensure`, `message.post`, ...) and the adapter calls the bridge
 * (`message.received`, `command.invoked`, ...). Request ids are scoped to
 * the sender, so each side keeps its own counter.
 */
import { Schema } from "effect"

export const Version = Schema.Literal("2.0")

export const Id = Schema.Union([Schema.String, Schema.Int]).annotate({
  identifier: "JsonRpcId"
})
export type Id = typeof Id.Type

export const Request = Schema.Struct({
  jsonrpc: Version,
  id: Id,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Json)
})
export type Request = typeof Request.Type

export const Notification = Schema.Struct({
  jsonrpc: Version,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Json)
})
export type Notification = typeof Notification.Type

export const ErrorObject = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Json)
}).annotate({ identifier: "JsonRpcError" })
export type ErrorObject = typeof ErrorObject.Type

export const Success = Schema.Struct({
  jsonrpc: Version,
  id: Id,
  result: Schema.Json
})
export type Success = typeof Success.Type

export const Failure = Schema.Struct({
  jsonrpc: Version,
  id: Schema.NullOr(Id),
  error: ErrorObject
})
export type Failure = typeof Failure.Type

/**
 * Any message on the wire. Order matters: excess keys are ignored, so the
 * stricter shapes come first (a request also looks like a notification, and a
 * failure would also pass as a success with a missing result).
 */
export const Message = Schema.Union([Request, Notification, Failure, Success])
export type Message = typeof Message.Type

/** Decodes one line of the stream. */
export const MessageFromLine = Schema.fromJsonString(Message)

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** The peer lacks the capability the method needs. */
  Unsupported: -32001,
  /** The room, thread or message no longer exists on the platform. */
  NotFound: -32002,
  /** `hello`: the adapter rejected its config section. */
  InvalidConfig: -32003,
  /** `hello`: the adapter does not speak this protocol version. */
  UnsupportedProtocol: -32004
} as const
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]
