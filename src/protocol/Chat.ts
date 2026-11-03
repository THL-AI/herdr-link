/**
 * Data types of the Chat protocol, the one the bridge speaks with adapters.
 *
 * Vocabulary: a Room groups Threads (a herdr space ↔ a Discord category), a
 * Thread is one conversation (a herdr tab ↔ a Discord channel). "Direct" is
 * the private conversation with the owner (a Discord DM), used as the control
 * room. Platform ids are opaque strings: the bridge stores them and hands them
 * back, it never parses them.
 */
import { Schema } from "effect"

export const ProtocolVersion = Schema.Literal(1).annotate({
  identifier: "ProtocolVersion",
  description: "Version of the Chat protocol. Bumped only on breaking changes."
})
export type ProtocolVersion = typeof ProtocolVersion.Type

export const RoomId = Schema.NonEmptyString.pipe(Schema.brand("RoomId")).annotate({
  identifier: "RoomId",
  description: "Platform id of a room (Discord: category id)."
})
export type RoomId = typeof RoomId.Type

export const ThreadId = Schema.NonEmptyString.pipe(Schema.brand("ThreadId")).annotate({
  identifier: "ThreadId",
  description: "Platform id of a thread (Discord: channel id)."
})
export type ThreadId = typeof ThreadId.Type

export const MessageId = Schema.NonEmptyString.pipe(Schema.brand("MessageId")).annotate({
  identifier: "MessageId",
  description: "Platform id of a message."
})
export type MessageId = typeof MessageId.Type

export const ActionId = Schema.NonEmptyString.pipe(Schema.brand("ActionId")).annotate({
  identifier: "ActionId",
  description: "Chosen by the bridge for a button or choice, echoed back in action.pressed."
})
export type ActionId = typeof ActionId.Type

export const Place = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("thread"), thread: ThreadId }),
  Schema.Struct({ kind: Schema.Literal("direct") })
]).annotate({
  identifier: "Place",
  description: "Where a message lives: a thread, or the direct conversation with the owner."
})
export type Place = typeof Place.Type

export const Emoji = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unicode"), value: Schema.NonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("custom"),
    name: Schema.NonEmptyString.annotate({
      description: "Name of a custom emoji the adapter knows (e.g. an agent logo such as `claude`)."
    })
  })
]).annotate({ identifier: "Emoji" })
export type Emoji = typeof Emoji.Type

export const ActionStyle = Schema.Literals(["primary", "secondary", "success", "danger"]).annotate({
  identifier: "ActionStyle"
})
export type ActionStyle = typeof ActionStyle.Type

export const Action = Schema.Struct({
  id: ActionId,
  label: Schema.NonEmptyString,
  style: Schema.optionalKey(ActionStyle),
  emoji: Schema.optionalKey(Emoji)
}).annotate({
  identifier: "Action",
  description: "A button under a message. Adapters without buttons may render it as text or a reaction."
})
export type Action = typeof Action.Type

export const Choice = Schema.Struct({
  id: ActionId,
  label: Schema.NonEmptyString,
  emoji: Schema.optionalKey(Emoji)
}).annotate({
  identifier: "Choice",
  description: "One answer of an `ask`. The adapter may offer it as a button, a reaction or both."
})
export type Choice = typeof Choice.Type

export const OutgoingFile = Schema.Struct({
  path: Schema.NonEmptyString.annotate({ description: "Absolute path on the bridge's machine." }),
  name: Schema.optionalKey(Schema.NonEmptyString)
}).annotate({ identifier: "OutgoingFile" })
export type OutgoingFile = typeof OutgoingFile.Type

export const Attachment = Schema.Struct({
  name: Schema.String,
  url: Schema.NonEmptyString.annotate({ description: "Where the bridge can download the file." }),
  size: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  contentType: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "Attachment" })
export type Attachment = typeof Attachment.Type

export const Capabilities = Schema.Struct({
  rooms: Schema.Boolean.annotate({ description: "Threads can be grouped into rooms." }),
  direct: Schema.Boolean.annotate({ description: "A direct conversation with the owner exists." }),
  threadCreation: Schema.Boolean.annotate({
    description: "The owner can create threads on the platform; the adapter reports them with thread.created."
  }),
  actions: Schema.Boolean.annotate({ description: "Messages can carry buttons." }),
  reactions: Schema.Boolean,
  customEmoji: Schema.Boolean.annotate({ description: "Emoji of kind `custom` can be shown." }),
  commands: Schema.Boolean.annotate({ description: "Slash commands (see CommandSpec)." }),
  edit: Schema.Boolean.annotate({ description: "Sent messages can be edited." }),
  files: Schema.Boolean.annotate({ description: "Files can be sent and received." }),
  maxText: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
    description: "Longest text of one message. The bridge splits longer text itself."
  }),
  maxActions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
    description: "Most actions or choices on one message."
  }),
  status: Schema.optionalKey(Schema.Boolean.annotate({
    description: "Send thread.status: every agent's state as data, for an adapter that acts on it (a program " +
      "driving agents, a status icon). Chat apps leave it out; their messages already say it."
  }))
}).annotate({ identifier: "Capabilities" })
export type Capabilities = typeof Capabilities.Type

export const CommandOption = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9_-]{1,32}$/u)),
  description: Schema.NonEmptyString,
  type: Schema.Literals(["string", "integer", "boolean"]),
  required: Schema.Boolean,
  choices: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
}).annotate({ identifier: "CommandOption" })
export type CommandOption = typeof CommandOption.Type

export const CommandSpec = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9_-]{1,32}( [a-z0-9_-]{1,32}){0,2}$/u)).annotate({
    description: "Space-separated path, e.g. `space new` (Discord: command `space`, subcommand `new`)."
  }),
  description: Schema.NonEmptyString,
  options: Schema.Array(CommandOption)
}).annotate({ identifier: "CommandSpec" })
export type CommandSpec = typeof CommandSpec.Type

export const CommandArgs = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])
).annotate({ identifier: "CommandArgs" })
export type CommandArgs = typeof CommandArgs.Type

export const AgentInfo = Schema.Struct({
  name: Schema.NonEmptyString.annotate({
    description: "The name `space.create` and `thread.created` take as `agent` (claude, grok, shell…)."
  }),
  emoji: Schema.NonEmptyString.annotate({ description: "It starts thread names: `✳️fix-login`." }),
  logo: Schema.optionalKey(Schema.NonEmptyString.annotate({
    description: "A custom emoji's name, for adapters that have custom emoji (Discord: an app emoji)."
  }))
}).annotate({ identifier: "AgentInfo" })
export type AgentInfo = typeof AgentInfo.Type

export const AdapterInfo = Schema.Struct({
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString
}).annotate({ identifier: "AdapterInfo" })
export type AdapterInfo = typeof AdapterInfo.Type
