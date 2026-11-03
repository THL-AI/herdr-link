/**
 * The Discord adapter: a separate process speaking the Chat protocol on
 * stdin/stdout. Rooms are private categories (only the owner and the bot see
 * them), threads are text channels, `direct` is the DM with the owner.
 *
 * Everything inbound is checked against the owner's user id: whoever can type
 * in these channels can run code on the owner's machine.
 *
 * Config section: `owner` and `guild` (snowflakes). Env: `DISCORD_TOKEN`.
 */
import { NodeRuntime } from "@effect/platform-node"
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type CategoryChannel,
  ChannelType,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  type Guild,
  type Message,
  type MessageCreateOptions,
  MessageFlags,
  type OverwriteResolvable,
  OverwriteType,
  Partials,
  PermissionFlagsBits,
  type SendableChannels,
  type TextChannel
} from "discord.js"
import { Effect, Logger, Schema } from "effect"
import {
  type Action,
  ActionId,
  type Choice,
  type CommandSpec,
  type Emoji,
  MessageId,
  type Place,
  RoomId,
  ThreadId
} from "../../protocol/Chat.ts"
import { ErrorCode } from "../../protocol/JsonRpc.ts"
import { AdapterToBridge, BridgeToAdapter } from "../../protocol/Methods.ts"
import * as Peer from "../../protocol/Peer.ts"
import * as StdioTransport from "../../protocol/StdioTransport.ts"

StdioTransport.guardStdout()

const Snowflake = Schema.String.check(Schema.isPattern(/^\d{15,22}$/u))
const Config = Schema.Struct({ owner: Snowflake, guild: Snowflake })
type Config = typeof Config.Type

const version = "0.0.1"
const maxText = 2000
const buttonsPerRow = 5
const maxActions = 25

const rpcError = (code: number, message: string) => new Peer.RpcError({ code, message })

/** Runs a discord.js call, turning its failures into JSON-RPC errors. */
/** Rate limits longer than this fail at once instead of holding the call (see the client's `rest` options). */
const longestWait = 5000

/** discord.js's RateLimitError, thrown for waits over `longestWait`; its name carries the route ("RateLimitError[/channels/:id]"). */
const isRateLimited = (error: unknown): error is { readonly timeToReset: number; readonly retryAfter: number } =>
  error instanceof Error && error.name.startsWith("RateLimitError")

const toRpcError = (what: string, error: unknown): Peer.RpcError => {
  if (error instanceof Peer.RpcError) return error
  if (error instanceof DiscordAPIError) {
    // 10003 Unknown Channel, 10008 Unknown Message
    const notFound = error.code === 10003 || error.code === 10008
    return rpcError(notFound ? ErrorCode.NotFound : ErrorCode.InternalError, `${what}: ${error.message}`)
  }
  if (isRateLimited(error)) {
    return rpcError(ErrorCode.InternalError, `${what}: rate limited by Discord for ${Math.ceil(error.timeToReset / 1000)} s`)
  }
  return rpcError(ErrorCode.InternalError, `${what}: ${String(error)}`)
}

/** Runs a discord.js call, turning its failures into JSON-RPC errors. */
const discord = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => toRpcError(what, error) })

/**
 * For cosmetic changes Discord limits hard (a channel's name: twice per ten
 * minutes): when rate limited, skip it with a log line; the next sync, which
 * sees the old name, tries again.
 */
const postponable = (what: string, run: () => Promise<unknown>) =>
  Effect.tryPromise({ try: run, catch: (error) => error }).pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      isRateLimited(error)
        ? Effect.logWarning(`${what}: rate limited by Discord, postponed (${Math.ceil(error.timeToReset / 1000)} s)`)
        : Effect.fail(toRpcError(what, error))
    )
  )

/** Names compared the way Discord may store them (emoji variation selectors dropped). */
const sameName = (a: string, b: string) => a.replace(/\uFE0F/g, "") === b.replace(/\uFE0F/g, "")

/** Discord lowercases text channel names and turns spaces into dashes. */
const channelName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 100)

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
  // Don't hold a call for minutes behind a rate limit (a third rename in ten minutes):
  // fail it instead, so the bridge keeps going.
  rest: { rejectOnRateLimit: (limit) => Math.max(limit.retryAfter, limit.sublimitTimeout, limit.timeToReset) > longestWait }
})

interface Session {
  readonly config: Config
  readonly guild: Guild
  /** Application emoji by name (agent logos), usable everywhere including DMs. */
  readonly emoji: Map<string, { readonly id: string; readonly name: string }>
  /** Messages with an `ask`: emoji → choice id, so a reaction can answer it. */
  readonly asks: Map<string, Map<string, string>>
}

let session: Session | undefined

const current = () =>
  session === undefined
    ? Effect.fail(rpcError(ErrorCode.InvalidRequest, "hello first"))
    : Effect.succeed(session)

const privateOverwrites = (s: Session): Array<OverwriteResolvable> => [
  { id: s.guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
  {
    id: s.config.owner,
    type: OverwriteType.Member,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.AddReactions
    ]
  },
  {
    id: client.user!.id,
    type: OverwriteType.Member,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.AddReactions,
      PermissionFlagsBits.ManageChannels
    ]
  }
]

const emojiKey = (emoji: Emoji) => (emoji.kind === "unicode" ? emoji.value : `:${emoji.name}:`)

/** What discord.js accepts for a reaction or a button: a unicode string or a custom emoji id. */
const resolveEmoji = (s: Session, emoji: Emoji) => {
  if (emoji.kind === "unicode") return emoji.value
  const found = s.emoji.get(emoji.name)
  return found === undefined ? undefined : found.id
}

const buttonStyle = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger
} as const

const actionRows = (s: Session, actions: ReadonlyArray<Action>) => {
  const rows: Array<ActionRowBuilder<ButtonBuilder>> = []
  actions.slice(0, maxActions).forEach((action, index) => {
    if (index % buttonsPerRow === 0) rows.push(new ActionRowBuilder<ButtonBuilder>())
    const button = new ButtonBuilder()
      .setCustomId(action.id)
      .setLabel(action.label.slice(0, 80))
      .setStyle(buttonStyle[action.style ?? "secondary"])
    const emoji = action.emoji === undefined ? undefined : resolveEmoji(s, action.emoji)
    if (emoji !== undefined) button.setEmoji(emoji)
    rows.at(-1)!.addComponents(button)
  })
  return rows
}

const channelOf = (s: Session, place: Place) =>
  discord("resolve place", async (): Promise<SendableChannels> => {
    if (place.kind === "direct") return (await client.users.fetch(s.config.owner)).createDM()
    const channel = await client.channels.fetch(place.thread)
    if (channel === null || !channel.isSendable() || ("guildId" in channel && channel.guildId !== s.guild.id)) {
      throw rpcError(ErrorCode.NotFound, `no channel ${place.thread}`)
    }
    return channel
  })

const placeOf = (message: Pick<Message, "guildId" | "channelId">): Place | undefined => {
  if (message.guildId === null) return { kind: "direct" }
  if (message.guildId !== session?.guild.id) return undefined
  return { kind: "thread", thread: ThreadId.make(message.channelId) }
}

const optionType = { string: 3, integer: 4, boolean: 5 } as const

/**
 * CommandSpecs as Discord application commands: `space new` becomes command
 * `space` with subcommand `new`. Global, so they work in the DM too.
 */
const slashCommands = (specs: ReadonlyArray<CommandSpec>) => {
  const options = (spec: CommandSpec) =>
    [...spec.options]
      .sort((a, b) => Number(b.required) - Number(a.required)) // Discord wants required options first
      .map((option) => ({
        type: optionType[option.type],
        name: option.name,
        description: option.description.slice(0, 100),
        required: option.required,
        ...(option.choices === undefined
          ? {}
          : { choices: option.choices.slice(0, 25).map((choice) => ({ name: choice, value: choice })) })
      }))
  const top = new Map<string, { name: string; description: string; options: Array<unknown> }>()
  for (const spec of specs) {
    const [name, sub] = spec.name.split(" ") as [string, string | undefined]
    if (sub === undefined) {
      top.set(name, { name, description: spec.description.slice(0, 100), options: options(spec) })
      continue
    }
    const parent = top.get(name) ?? { name, description: `${name} commands`, options: [] }
    parent.options.push({ type: 1, name: sub, description: spec.description.slice(0, 100), options: options(spec) })
    top.set(name, parent)
  }
  return [...top.values()].map((command) => ({ ...command, contexts: [0, 1], integration_types: [0] })) as never
}

/** Channels this adapter created itself: their channelCreate is not the owner's doing. */
const ownCreations = new Set<string>()
/** The gateway may announce a channel before the REST call that made it returns. */
const ownCreationGrace = 3000

/** Channels this adapter is deleting itself: their channelDelete is not the owner's doing. */
const deleting = new Set<string>()

const deleteChannel = (id: string, type: ChannelType.GuildText | ChannelType.GuildCategory) =>
  Effect.gen(function*() {
    const s = yield* current()
    const channel = yield* discord("fetch channel", () => s.guild.channels.fetch(id)).pipe(
      Effect.catch(() => Effect.succeed(null))
    )
    if (channel === null || channel.type !== type) return yield* rpcError(ErrorCode.NotFound, `no channel ${id}`)
    deleting.add(id)
    yield* discord("delete channel", async () => { await channel.delete() }).pipe(
      Effect.tapError(() => Effect.sync(() => deleting.delete(id)))
    )
    yield* Effect.logInfo(`deleted ${type === ChannelType.GuildCategory ? "category" : "channel"} ${channel.name} (${id})`)
    return {}
  })

const handlers = (): Peer.Handlers<typeof BridgeToAdapter> => ({
  hello: ({ config, commands }) =>
    Effect.gen(function*() {
      const decoded = yield* Schema.decodeUnknownEffect(Config)(config).pipe(
        Effect.mapError((issue) => rpcError(ErrorCode.InvalidConfig, `config: ${issue.message}`))
      )
      const token = process.env.DISCORD_TOKEN
      if (token === undefined || token === "") {
        return yield* rpcError(ErrorCode.InvalidConfig, "DISCORD_TOKEN is not set (list it in the adapter's `env`)")
      }
      yield* discord("login", async () => {
        const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()))
        await client.login(token)
        await ready
      })
      const guild = yield* discord("fetch guild", () => client.guilds.fetch(decoded.guild)).pipe(
        Effect.mapError((error) => rpcError(ErrorCode.InvalidConfig, `the bot is not in guild ${decoded.guild}: ${error.message}`))
      )
      const emoji = new Map<string, { id: string; name: string }>()
      const appEmoji = yield* discord("fetch application emoji", () => client.application!.emojis.fetch()).pipe(
        Effect.catch((error) => Effect.logWarning(error.message).pipe(Effect.as(undefined)))
      )
      for (const e of appEmoji?.values() ?? []) if (e.name !== null) emoji.set(e.name, { id: e.id, name: e.name })

      if (commands.length > 0) {
        yield* discord("register commands", () => client.application!.commands.set(slashCommands(commands)))
      }
      session = { config: decoded, guild, emoji, asks: new Map() }
      client.user?.setPresence({ activities: [], status: "online" })
      yield* Effect.logInfo(`logged in as ${client.user?.tag} on ${guild.name}; app emoji: ${[...emoji.keys()].join(", ") || "none"}`)
      return {
        protocol: 1 as const,
        adapter: { name: "discord", version },
        capabilities: {
          rooms: true,
          direct: true,
          threadCreation: true,
          actions: true,
          reactions: true,
          customEmoji: true,
          commands: true,
          edit: true,
          files: true,
          maxText,
          maxActions
        }
      }
    }),

  "room.ensure": ({ room, name }) =>
    Effect.gen(function*() {
      const s = yield* current()
      if (room !== undefined) {
        const existing = yield* discord("fetch room", () => s.guild.channels.fetch(room)).pipe(
          Effect.catch(() => Effect.succeed(null))
        )
        if (existing !== null && existing.type === ChannelType.GuildCategory) {
          if (existing.name !== name) yield* postponable("rename room", () => existing.setName(name))
          return { room, created: false }
        }
      }
      const created = yield* discord("create room", () =>
        s.guild.channels.create({ name, type: ChannelType.GuildCategory, permissionOverwrites: privateOverwrites(s) }))
      yield* Effect.logInfo(`created category ${name} (${created.id})`)
      return { room: RoomId.make(created.id), created: true }
    }),

  "thread.ensure": ({ room, thread, name, topic }) =>
    Effect.gen(function*() {
      const s = yield* current()
      if (room === undefined) return yield* rpcError(ErrorCode.InvalidParams, "Discord threads live in a room")
      const wanted = name === undefined ? undefined : channelName(name)
      if (thread !== undefined) {
        const existing = yield* discord("fetch thread", () => s.guild.channels.fetch(thread)).pipe(
          Effect.catch(() => Effect.succeed(null))
        )
        if (existing !== null && existing.type === ChannelType.GuildText) {
          const channel = existing as TextChannel
          if (channel.parentId !== room) {
            yield* discord("move thread", () => channel.setParent(room, { lockPermissions: true }))
          }
          // Discord allows two renames per channel per ten minutes: rename only on a real change.
          if (wanted !== undefined && sameName(channel.name, wanted) === false) {
            yield* postponable("rename thread", () => channel.setName(wanted))
          }
          if (topic !== undefined && (channel.topic ?? "") !== topic) {
            yield* postponable("set topic", () => channel.setTopic(topic))
          }
          return { thread, created: false }
        }
      }
      if (wanted === undefined) {
        return yield* rpcError(thread === undefined ? ErrorCode.InvalidParams : ErrorCode.NotFound, "no such thread, and no name to create one")
      }
      const parent = yield* discord("fetch room", () => s.guild.channels.fetch(room))
      if (parent === null || parent.type !== ChannelType.GuildCategory) {
        return yield* rpcError(ErrorCode.NotFound, `no room ${room}`)
      }
      const created = yield* discord("create thread", () =>
        s.guild.channels.create({
          name: wanted,
          type: ChannelType.GuildText,
          parent: parent as CategoryChannel,
          permissionOverwrites: privateOverwrites(s),
          ...(topic === undefined ? {} : { topic })
        }))
      ownCreations.add(created.id)
      yield* Effect.logInfo(`created channel #${wanted} (${created.id})`)
      return { thread: ThreadId.make(created.id), created: true }
    }),

  "thread.delete": ({ thread }) => deleteChannel(thread, ChannelType.GuildText),

  "room.delete": ({ room }) => deleteChannel(room, ChannelType.GuildCategory),
  // A chat app shows its messages; the agents' states as data are for programs.
  "thread.status": () => Effect.void,

  "message.post": ({ place, text, files, actions, replyTo, silent }) =>
    Effect.gen(function*() {
      const s = yield* current()
      const channel = yield* channelOf(s, place)
      const options: MessageCreateOptions = {
        allowedMentions: { parse: [] },
        ...(text === "" ? {} : { content: text }),
        ...(files === undefined ? {} : { files: files.map((f) => ({ attachment: f.path, ...(f.name ? { name: f.name } : {}) })) }),
        ...(actions === undefined ? {} : { components: actionRows(s, actions) }),
        ...(replyTo === undefined ? {} : { reply: { messageReference: replyTo, failIfNotExists: false } }),
        ...(silent === true ? { flags: MessageFlags.SuppressNotifications } : {})
      }
      const sent = yield* discord("send", async () => (await channel.send(options)).id)
      return { message: MessageId.make(sent) }
    }),

  "message.edit": ({ place, message, text, actions }) =>
    Effect.gen(function*() {
      const s = yield* current()
      const channel = yield* channelOf(s, place)
      yield* discord("edit", () =>
        channel.messages.edit(message, {
          ...(text === undefined ? {} : { content: text }),
          ...(actions === undefined ? {} : { components: actionRows(s, actions) })
        }))
      return {}
    }),

  react: ({ place, message, emoji }) =>
    Effect.gen(function*() {
      const s = yield* current()
      const channel = yield* channelOf(s, place)
      const resolved = resolveEmoji(s, emoji)
      if (resolved === undefined) return yield* rpcError(ErrorCode.InvalidParams, `unknown emoji ${emojiKey(emoji)}`)
      yield* discord("react", async () => (await channel.messages.fetch(message)).react(resolved))
      return {}
    }),

  ask: ({ place, text, choices, silent }) =>
    Effect.gen(function*() {
      const s = yield* current()
      const channel = yield* channelOf(s, place)
      const sent: Message = yield* discord("ask", async (): Promise<Message> =>
        channel.send({
          content: text,
          allowedMentions: { parse: [] },
          ...(silent === true ? { flags: MessageFlags.SuppressNotifications as const } : {}),
          components: actionRows(s, choices.map((c: Choice) => ({ id: c.id, label: c.label, ...(c.emoji ? { emoji: c.emoji } : {}) })))
        }))
      const byEmoji = new Map<string, string>()
      for (const choice of choices) {
        if (choice.emoji === undefined) continue
        const resolved = resolveEmoji(s, choice.emoji)
        if (resolved === undefined) continue
        byEmoji.set(emojiKey(choice.emoji), choice.id)
        yield* discord("react", () => sent.react(resolved)).pipe(Effect.ignore)
      }
      s.asks.set(sent.id, byEmoji)
      return { message: MessageId.make(sent.id) }
    })
})

const run = Effect.gen(function*() {
  const peer = yield* Peer.make({
    transport: StdioTransport.make(),
    outgoing: AdapterToBridge,
    incoming: BridgeToAdapter,
    handlers
  })

  // discord.js callbacks run outside Effect: fork each notification in order.
  const send = (effect: Effect.Effect<void, unknown>) => {
    Effect.runFork(effect.pipe(Effect.catchCause((cause) => Effect.logError(cause))))
  }
  const isOwner = (userId: string) => session !== undefined && userId === session.config.owner

  client.on("raw", (packet: { t?: string; d?: unknown }) => {
    if (packet.t === "CHANNEL_CREATE") console.error(`raw CHANNEL_CREATE ${JSON.stringify(packet.d)}`)
  })

  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot || !isOwner(message.author.id)) return
    const place = placeOf(message)
    if (place === undefined) return
    send(peer.notify("message.received", {
      place,
      message: MessageId.make(message.id),
      text: message.content,
      attachments: [...message.attachments.values()].map((a) => ({
        name: a.name,
        url: a.url,
        size: a.size,
        ...(a.contentType === null ? {} : { contentType: a.contentType })
      })),
      ...(message.reference?.messageId === undefined ? {} : { replyTo: MessageId.make(message.reference.messageId) })
    }))
  })

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    if (!isOwner(user.id)) return
    send(Effect.gen(function*() {
      const full = reaction.partial ? yield* discord("fetch reaction", () => reaction.fetch()) : reaction
      const place = placeOf(full.message)
      if (place === undefined) return
      const emoji: Emoji = full.emoji.id === null
        ? { kind: "unicode", value: full.emoji.name ?? "?" }
        : { kind: "custom", name: full.emoji.name ?? full.emoji.id }
      const choice = session?.asks.get(full.message.id)?.get(emojiKey(emoji))
      if (choice !== undefined) {
        return yield* peer.notify("action.pressed", { place, message: MessageId.make(full.message.id), action: ActionId.make(choice) })
      }
      yield* peer.notify("reaction.added", { place, message: MessageId.make(full.message.id), emoji })
    }))
  })

  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand()) {
      if (!isOwner(interaction.user.id)) {
        send(discord("refuse", () => interaction.reply({ content: "This bot answers only its owner.", ephemeral: true })))
        return
      }
      const place: Place | undefined = interaction.guildId === null
        ? { kind: "direct" }
        : interaction.guildId === session?.guild.id
        ? { kind: "thread", thread: ThreadId.make(interaction.channelId) }
        : undefined
      if (place === undefined) return
      const sub = interaction.options.getSubcommand(false)
      const options = sub === null ? interaction.options.data : (interaction.options.data[0]?.options ?? [])
      const args: Record<string, string | number | boolean> = {}
      for (const option of options) {
        if (typeof option.value === "string" || typeof option.value === "number" || typeof option.value === "boolean") {
          args[option.name] = option.value
        }
      }
      send(Effect.gen(function*() {
        yield* discord("defer", () => interaction.deferReply())
        const reply = yield* peer.request("command.invoked", {
          place,
          command: sub === null ? interaction.commandName : `${interaction.commandName} ${sub}`,
          args
        }).pipe(Effect.catch((error) => Effect.succeed({ text: `⚠️ ${error.message}` })))
        yield* discord("reply", () => interaction.editReply({ content: reply.text.slice(0, maxText), allowedMentions: { parse: [] } }))
      }))
      return
    }
    if (!interaction.isButton()) return
    if (!isOwner(interaction.user.id)) {
      send(discord("refuse", () => interaction.reply({ content: "This bot answers only its owner.", ephemeral: true })))
      return
    }
    const place = placeOf(interaction.message)
    if (place === undefined) return
    send(discord("ack", () => interaction.deferUpdate()).pipe(
      Effect.andThen(peer.notify("action.pressed", {
        place,
        message: MessageId.make(interaction.message.id),
        action: ActionId.make(interaction.customId)
      }))
    ))
  })

  client.on(Events.ChannelCreate, (channel) => {
    if (session === undefined || channel.guildId !== session.guild.id || channel.type !== ChannelType.GuildText) return
    setTimeout(() => {
      if (ownCreations.delete(channel.id)) return // made by thread.ensure
      send(peer.notify("thread.created", {
        ...(channel.parentId === null ? {} : { room: RoomId.make(channel.parentId) }),
        thread: ThreadId.make(channel.id),
        name: channel.name
      }))
    }, ownCreationGrace)
  })

  client.on(Events.ChannelDelete, (channel) => {
    if (session === undefined || channel.isDMBased() || channel.guildId !== session.guild.id) return
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildCategory) return
    if (deleting.delete(channel.id)) return // our own thread.delete or room.delete
    // A category goes alone: its channels stay, without one (the bridge archives them once the space is closed).
    send(
      channel.type === ChannelType.GuildCategory
        ? peer.notify("room.deleted", { room: RoomId.make(channel.id) })
        : peer.notify("thread.deleted", { thread: ThreadId.make(channel.id) })
    )
  })

  const closed = yield* peer.closed
  yield* Effect.logInfo(`bridge went away (${closed.message}); logging out`)
  yield* Effect.promise(() => client.destroy())
}).pipe(
  Effect.scoped,
  Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatSimple)]))
)

NodeRuntime.runMain(run)
