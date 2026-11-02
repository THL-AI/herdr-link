/**
 * Exports the Chat protocol as an OpenRPC document for adapter authors, the
 * way `hc schema` does for herdr-core. OpenRPC describes one direction, so
 * every method carries a tag saying who calls it; methods without `result`
 * are notifications.
 */
import { type JsonSchema, Predicate, Schema, SchemaRepresentation } from "effect"
import { ErrorCode } from "./JsonRpc.ts"
import { AdapterToBridge, BridgeToAdapter, type MethodDef } from "./Methods.ts"

const tags = {
  bridge: { name: "bridge-to-adapter", description: "Sent by the bridge, handled by the adapter." },
  adapter: { name: "adapter-to-bridge", description: "Sent by the adapter, handled by the bridge." }
} as const

const errorDescriptions: Record<keyof typeof ErrorCode, string> = {
  ParseError: "The line is not valid JSON.",
  InvalidRequest: "The JSON is not a valid JSON-RPC 2.0 message.",
  MethodNotFound: "Unknown method.",
  InvalidParams: "Params do not match the schema.",
  InternalError: "Unexpected failure while handling the request.",
  Unsupported: "The method needs a capability the adapter did not declare.",
  NotFound: "The room, thread or message no longer exists on the platform.",
  InvalidConfig: "hello: the adapter rejected its config section.",
  UnsupportedProtocol: "hello: the adapter does not speak this protocol version."
}

export const make = (): Record<string, unknown> => {
  const entries = [
    ...Object.values(BridgeToAdapter).map((def) => ({ def: def as MethodDef, tag: tags.bridge })),
    ...Object.values(AdapterToBridge).map((def) => ({ def: def as MethodDef, tag: tags.adapter }))
  ]
  const asts = entries.flatMap(({ def }) =>
    def._tag === "Request" ? [jsonAst(def.params), jsonAst(def.result)] : [jsonAst(def.params)]
  )
  const [first, ...rest] = asts
  if (first === undefined) throw new Error("the Chat protocol has no methods")
  const document = SchemaRepresentation.toJsonSchemaMultiDocument(
    SchemaRepresentation.toRepresentations([first, ...rest])
  )
  const toComponents = (schema: JsonSchema.JsonSchema) => rewriteRefs(schema) as JsonSchema.JsonSchema

  const schemas = document.schemas.map(toComponents)
  let next = 0
  const take = () => {
    const schema = schemas[next++]
    if (schema === undefined) throw new Error("schema count mismatch")
    return schema
  }

  const methods = entries.map(({ def, tag }) => {
    const params = take()
    const result = def._tag === "Request" ? take() : undefined
    return {
      name: def.method,
      description: def.description,
      tags: [{ $ref: `#/components/tags/${tag.name}` }],
      paramStructure: "by-name",
      params: paramDescriptors(def.method, params),
      ...(result === undefined ? {} : { result: { name: `${def.method}.result`, schema: result } })
    }
  })

  return {
    openrpc: "1.3.2",
    info: {
      title: "herdr-link Chat protocol",
      version: "1",
      description:
        "JSON-RPC 2.0 over the adapter's stdin/stdout, one message per line. Both sides send requests and " +
        "notifications. The bridge spawns the adapter and sends `hello` first. stderr is log output. " +
        "Error codes: " +
        Object.entries(ErrorCode)
          .map(([name, code]) => `${code} ${name} (${errorDescriptions[name as keyof typeof ErrorCode]})`)
          .join("; ")
    },
    methods,
    components: {
      schemas: Object.fromEntries(
        Object.entries(document.definitions).map(([name, schema]) => [name, toComponents(schema)])
      ),
      tags: Object.fromEntries(Object.values(tags).map((tag) => [tag.name, tag]))
    }
  }
}

/** Points `#/$defs/X` references at `#/components/schemas/X`. */
const rewriteRefs = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(rewriteRefs)
  if (!Predicate.isObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      key === "$ref" && typeof v === "string" ? v.replace(/^#\/\$defs\//, "#/components/schemas/") : rewriteRefs(v)
    ])
  )
}

const jsonAst = (schema: Schema.Codec<any, any>) => Schema.toCodecJson(schema).ast

/** OpenRPC wants by-name params as one content descriptor per property. */
const paramDescriptors = (method: string, schema: JsonSchema.JsonSchema) => {
  const properties = schema.properties
  if (schema.type !== "object" || properties === undefined || typeof properties !== "object") {
    throw new Error(`params of ${method} must be an inline object schema`)
  }
  const required = new Set(Array.isArray(schema.required) ? (schema.required as Array<string>) : [])
  return Object.entries(properties as Record<string, JsonSchema.JsonSchema>).map(([name, property]) => ({
    name,
    required: required.has(name),
    schema: property
  }))
}
