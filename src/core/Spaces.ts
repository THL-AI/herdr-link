/**
 * Spaces and tabs as herdr-app keeps them: in the core document `herdr-app`
 * (a `doc` event with that name means the layout changed). Only what the
 * bridge needs is decoded; the pane tree is walked for its terminals.
 */
import { Effect, Predicate, Schema } from "effect"

export const docName = "herdr-app"

const RawTab = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.optionalKey(Schema.Json)
})

const RawSpace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  folder: Schema.String,
  /** The herdr machine its terminals run on (`hc machine`); absent or null: this one. */
  machine: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tabs: Schema.Array(RawTab)
})

const RawDoc = Schema.Struct({ spaces: Schema.Array(RawSpace) })

export interface Tab {
  readonly id: string
  readonly name: string
  /** Terminal addresses in its panes, in layout order. */
  readonly terminals: ReadonlyArray<string>
}

export interface Space {
  readonly id: string
  /** The name herdr-app shows: its own, else `~` for home, else the folder's basename. */
  readonly name: string
  readonly folder: string
  /** Set when the space lives on another herdr machine. */
  readonly machine?: string
  readonly tabs: ReadonlyArray<Tab>
}

const terminalsOf = (node: unknown, found: Array<string> = []): Array<string> => {
  if (!Predicate.isObject(node)) return found
  if (Predicate.hasProperty(node, "content") && Predicate.hasProperty(node.content, "terminal")) {
    const terminal = node.content.terminal
    if (Predicate.isString(terminal)) found.push(terminal)
  }
  if (Predicate.hasProperty(node, "children") && Array.isArray(node.children)) {
    for (const child of node.children) terminalsOf(child, found)
  }
  return found
}

export const displayName = (space: { readonly name: string; readonly folder: string }, home = process.env.HOME) => {
  if (space.name !== "") return space.name
  if (home !== undefined && space.folder === home) return "~"
  return space.folder.split("/").filter((part) => part !== "").at(-1) ?? space.folder
}

/** Decodes the document's value; an empty or deleted document means no spaces. */
export const decode = (value: unknown) =>
  value === null
    ? Effect.succeed<ReadonlyArray<Space>>([])
    : Schema.decodeUnknownEffect(RawDoc)(value).pipe(
      Effect.map((doc): ReadonlyArray<Space> =>
        doc.spaces.map((space) => ({
          id: space.id,
          name: displayName(space),
          folder: space.folder,
          ...(space.machine ? { machine: space.machine } : {}),
          tabs: space.tabs.map((tab) => ({ id: tab.id, name: tab.name, terminals: terminalsOf(tab.root) }))
        }))
      )
    )
