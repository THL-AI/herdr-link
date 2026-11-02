/**
 * Methods as data: name, params schema and, for requests, result schema.
 * Shared by the Chat protocol and the herdr-core client.
 */
import type { Schema } from "effect"

type AnyCodec = Schema.Codec<any, any>

export interface RequestDef<M extends string, P extends AnyCodec, R extends AnyCodec> {
  readonly _tag: "Request"
  readonly method: M
  readonly description: string
  readonly params: P
  readonly result: R
}

export interface NotificationDef<M extends string, P extends AnyCodec> {
  readonly _tag: "Notification"
  readonly method: M
  readonly description: string
  readonly params: P
}

export type MethodDef = RequestDef<string, AnyCodec, AnyCodec> | NotificationDef<string, AnyCodec>

export const request = <const M extends string, P extends AnyCodec, R extends AnyCodec>(
  method: M,
  description: string,
  params: P,
  result: R
): RequestDef<M, P, R> => ({ _tag: "Request", method, description, params, result })

export const notification = <const M extends string, P extends AnyCodec>(
  method: M,
  description: string,
  params: P
): NotificationDef<M, P> => ({ _tag: "Notification", method, description, params })

export type Params<D extends MethodDef> = D["params"]["Type"]
export type Result<D extends MethodDef> = D extends RequestDef<string, AnyCodec, infer R> ? R["Type"] : never
