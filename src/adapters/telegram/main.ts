/**
 * The Telegram adapter: a separate process speaking the Chat protocol on
 * stdin/stdout. Telegram has no rooms: every herdr tab is a topic of one
 * forum supergroup (named `✳️space / tab`), and `direct` is the bot's private
 * chat with the owner.
 *
 * Everything inbound is checked against the owner's user id: whoever can
 * write in these topics can run code on the owner's machine.
 *
 * Config section: `owner` (user id) and `group` (the supergroup's chat id,
 * `-100…`). Env: `TELEGRAM_TOKEN`. The bot must be an admin of the group
 * with "Manage topics", and the group must have topics turned on.
 *
 * Bots are never told about a deleted topic: the adapter checks its topics
 * every minute and reports the deleted ones. Closing a topic counts as
 * deleting it (its tab closes, the topic goes).
 *
 * Talks to the Bot API with fetch and long polling; no SDK.
 */
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Logger, Schedule, Schema } from "effect"
import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import {
  type Action,
  ActionId,
  type Attachment,
  type CommandSpec,
  MessageId,
  type Place,
  ThreadId
} from "../../protocol/Chat.ts"
import { ErrorCode } from "../../protocol/JsonRpc.ts"
import { AdapterToBridge, BridgeToAdapter } from "../../protocol/Methods.ts"
import * as Peer from "../../protocol/Peer.ts"
import * as StdioTransport from "../../protocol/StdioTransport.ts"
import { menu, parseCommand, toHtml } from "./Text.ts"

StdioTransport.guardStdout()

const UserId = Schema.String.check(Schema.isPattern(/^\d{1,20}$/u))
const ChatId = Schema.String.check(Schema.isPattern(/^-\d{1,20}$/u))
const Config = Schema.Struct({ owner: UserId, group: ChatId })
type Config = typeof Config.Type

const version = "0.0.1"
const maxText = 4096
const maxActions = 24
const buttonsPerRow = 3
/** Telegram's limit for callback data. Longer action ids are mapped to short keys. */
const maxCallbackBytes = 64
/** Waits for a rate limit up to this long; longer ones fail the call (the bridge times out at 30 s). */
const longestWait = 20
/** How often the adapter checks that its topics still exist (bots never hear of a deleted one). */
const topicCheckEvery = "1 minute"
/** What the Bot API says about a deleted topic; nothing else counts as gone. */
const topicGone = /TOPIC_ID_INVALID|TOPIC_DELETED|thread not found/i

/** Bots download files up to 20 MB. */
const maxDownload = 20 * 1024 * 1024

const rpcError = (code: number, message: string) => new Peer.RpcError({ code, message })

// The Bot API

interface ApiResponse<A> {
  readonly ok: boolean
  readonly result?: A
  readonly error_code?: number
  readonly description?: string
  readonly parameters?: { readonly retry_after?: number }
}

class TelegramError extends Error {
  constructor(readonly method: string, readonly code: number, readonly description: string) {
    super(`${method}: ${description}`)
  }
}

const token = process.env.TELEGRAM_TOKEN ?? ""

/** Never let the token reach a log line. */
const scrub = (text: string) => (token === "" ? text : text.replaceAll(token, "<token>"))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const api = async <A>(method: string, params: Record<string, unknown> | FormData = {}, signal?: AbortSignal): Promise<A> => {
  for (let attempt = 0;; attempt++) {
    let response: Response
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        ...(params instanceof FormData
          ? { body: params }
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(params) }),
        ...(signal === undefined ? {} : { signal })
      })
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code
      throw new TelegramError(method, 0, scrub(`network: ${cause ?? (error as Error).message}`))
    }
    const body = (await response.json().catch(() => ({ ok: false, description: `HTTP ${response.status}` }))) as ApiResponse<A>
    if (body.ok) return body.result as A
    const wait = body.parameters?.retry_after
    if (body.error_code === 429 && wait !== undefined && wait <= longestWait && attempt < 3) {
      await sleep(wait * 1000)
      continue
    }
    throw new TelegramError(method, body.error_code ?? response.status, scrub(body.description ?? "unknown error"))
  }
}

const isNotFound = (error: TelegramError) =>
  /thread not found|TOPIC_ID_INVALID|TOPIC_DELETED|message to edit not found|message not found|MESSAGE_ID_INVALID|chat not found/i
    .test(error.description)

const toRpcError = (error: unknown): Peer.RpcError => {
  if (error instanceof Peer.RpcError) return error
  if (error instanceof TelegramError) {
    return rpcError(isNotFound(error) ? ErrorCode.NotFound : ErrorCode.InternalError, error.message)
  }
  return rpcError(ErrorCode.InternalError, scrub(String(error)))
}

const telegram = <A>(method: string, params?: Record<string, unknown> | FormData) =>
  Effect.tryPromise({ try: () => api<A>(method, params), catch: toRpcError })

// Telegram types, as far as this adapter reads them

interface User {
  readonly id: number
  readonly is_bot: boolean
  readonly username?: string
  readonly first_name: string
}
interface FileRef {
  readonly file_id: string
  readonly file_size?: number
  readonly file_name?: string
  readonly mime_type?: string
}
interface TgMessage {
  readonly message_id: number
  readonly message_thread_id?: number
  readonly is_topic_message?: boolean
  readonly from?: User
  readonly chat: { readonly id: number; readonly type: string }
  readonly text?: string
  readonly caption?: string
  readonly entities?: ReadonlyArray<{ readonly type: string; readonly offset: number }>
  readonly reply_to_message?: TgMessage
  readonly forum_topic_created?: { readonly name: string }
  readonly forum_topic_closed?: object
  readonly forum_topic_edited?: { readonly name?: string }
  readonly photo?: ReadonlyArray<FileRef>
  readonly document?: FileRef
  readonly video?: FileRef
  readonly audio?: FileRef
  readonly voice?: FileRef
  readonly animation?: FileRef
}
interface Update {
  readonly update_id: number
  readonly message?: TgMessage
  readonly callback_query?: {
    readonly id: string
    readonly from: User
    readonly message?: TgMessage
    readonly data?: string
  }
}

// State

interface Session {
  readonly config: Config
  readonly me: User
  readonly commands: ReadonlyArray<CommandSpec>
}

let session: Session | undefined

const current = () =>
  session === undefined
    ? Effect.fail(rpcError(ErrorCode.InvalidRequest, "hello first"))
    : Effect.succeed(session)

/** Topic names as last set or seen, so a sync renames only on a real change. */
const topics = new Map<string, string>()

/** Short callback keys for action ids over Telegram's 64 bytes (in memory). */
const longActions = new Map<string, string>()
let nextAction = 1

const callbackData = (id: string) => {
  if (Buffer.byteLength(id) <= maxCallbackBytes) return id
  const key = `#${nextAction++}`
  longActions.set(key, id)
  return key
}

const target = (s: Session, place: Place) =>
  place.kind === "direct"
    ? { chat_id: s.config.owner }
    : { chat_id: s.config.group, message_thread_id: Number(place.thread) }

const keyboard = (actions: ReadonlyArray<Action>) => {
  const rows: Array<Array<{ text: string; callback_data: string }>> = []
  actions.slice(0, maxActions).forEach((action, index) => {
    if (index % buttonsPerRow === 0) rows.push([])
    const emoji = action.emoji?.kind === "unicode" ? `${action.emoji.value} ` : ""
    rows.at(-1)!.push({ text: `${emoji}${action.label}`, callback_data: callbackData(action.id) })
  })
  return { inline_keyboard: rows }
}

const cannotParse = (error: unknown) => error instanceof Peer.RpcError && /can't parse entities/i.test(error.message)

/** Sends Markdown as HTML; if Telegram refuses the markup, the same text plain. */
const sendText = (base: Record<string, unknown>, text: string) =>
  telegram<TgMessage>("sendMessage", { ...base, text: toHtml(text), parse_mode: "HTML" }).pipe(
    Effect.catchIf(cannotParse, () => telegram<TgMessage>("sendMessage", { ...base, text }))
  )

const sendFile = (base: Record<string, unknown>, path: string, name: string | undefined, extra: Record<string, unknown>) =>
  Effect.gen(function*() {
    const bytes = yield* Effect.tryPromise({ try: () => readFile(path), catch: (error) => rpcError(ErrorCode.InvalidParams, String(error)) })
    const form = new FormData()
    for (const [key, value] of Object.entries({ ...base, ...extra })) {
      form.append(key, typeof value === "string" ? value : JSON.stringify(value))
    }
    form.append("document", new Blob([bytes]), name ?? basename(path))
    return yield* telegram<TgMessage>("sendDocument", form)
  })

const edit = (base: Record<string, unknown>, text: string | undefined, actions: ReadonlyArray<Action> | undefined) => {
  const markup = actions === undefined ? {} : { reply_markup: keyboard(actions) }
  const notModified = (error: unknown) => error instanceof Peer.RpcError && /message is not modified/i.test(error.message)
  const run = text === undefined
    ? telegram("editMessageReplyMarkup", { ...base, ...markup })
    : telegram("editMessageText", { ...base, ...markup, text: toHtml(text), parse_mode: "HTML", link_preview_options: { is_disabled: true } }).pipe(
      Effect.catchIf(cannotParse, () => telegram("editMessageText", { ...base, ...markup, text, link_preview_options: { is_disabled: true } }))
    )
  return run.pipe(Effect.catchIf(notModified, () => Effect.void), Effect.asVoid)
}

const handlers = (): Peer.Handlers<typeof BridgeToAdapter> => ({
  hello: ({ config, commands }) =>
    Effect.gen(function*() {
      const decoded = yield* Schema.decodeUnknownEffect(Config)(config).pipe(
        Effect.mapError((issue) => rpcError(ErrorCode.InvalidConfig, `config: ${issue.message}`))
      )
      if (token === "") {
        return yield* rpcError(ErrorCode.InvalidConfig, "TELEGRAM_TOKEN is not set (list it in the adapter's `env`)")
      }
      const invalid = (message: string) => (error: Peer.RpcError) => rpcError(ErrorCode.InvalidConfig, `${message}: ${error.message}`)
      const me = yield* telegram<User>("getMe").pipe(Effect.mapError(invalid("the bot token does not work")))
      const group = yield* telegram<{ type: string; title?: string; is_forum?: boolean }>("getChat", { chat_id: decoded.group }).pipe(
        Effect.mapError(invalid(`the bot is not in group ${decoded.group}`))
      )
      if (group.type !== "supergroup" || group.is_forum !== true) {
        return yield* rpcError(ErrorCode.InvalidConfig, `${group.title ?? decoded.group}: turn on Topics in the group's settings`)
      }
      const member = yield* telegram<{ status: string; can_manage_topics?: boolean }>("getChatMember", {
        chat_id: decoded.group,
        user_id: me.id
      })
      if (member.status !== "administrator" || member.can_manage_topics !== true) {
        return yield* rpcError(
          ErrorCode.InvalidConfig,
          `make @${me.username} an admin of ${group.title ?? decoded.group} with "Manage topics"`
        )
      }
      yield* telegram("deleteWebhook") // long polling needs no webhook
      if (commands.length > 0) yield* telegram("setMyCommands", { commands: menu(commands) })
      session = { config: decoded, me, commands }
      yield* Effect.logInfo(`logged in as @${me.username} on ${group.title ?? decoded.group}`)
      return {
        protocol: 1 as const,
        adapter: { name: "telegram", version },
        capabilities: {
          rooms: false,
          direct: true,
          threadCreation: true,
          actions: true,
          reactions: true,
          customEmoji: false,
          commands: true,
          edit: true,
          files: true,
          maxText,
          maxActions
        }
      }
    }),

  "room.ensure": () => Effect.fail(rpcError(ErrorCode.Unsupported, "Telegram has no rooms")),
  "room.delete": () => Effect.fail(rpcError(ErrorCode.Unsupported, "Telegram has no rooms")),

  "thread.ensure": ({ thread, name }) =>
    Effect.gen(function*() {
      const s = yield* current()
      const wanted = name?.slice(0, 128)
      if (thread !== undefined) {
        if (wanted === undefined || topics.get(thread) === wanted) return { thread, created: false }
        // Also tells whether the topic still exists (there is no getForumTopic).
        const renamed = yield* telegram("editForumTopic", {
          chat_id: s.config.group,
          message_thread_id: Number(thread),
          name: wanted
        }).pipe(
          Effect.as(true),
          Effect.catchIf((error) => /TOPIC_NOT_MODIFIED/i.test(error.message), () => Effect.succeed(true)),
          Effect.catchIf((error) => error.code === ErrorCode.NotFound, () => Effect.succeed(false))
        )
        if (renamed) {
          topics.set(thread, wanted)
          return { thread, created: false }
        }
      }
      if (wanted === undefined) {
        return yield* rpcError(thread === undefined ? ErrorCode.InvalidParams : ErrorCode.NotFound, "no such topic, and no name to create one")
      }
      const created = yield* telegram<{ message_thread_id: number }>("createForumTopic", { chat_id: s.config.group, name: wanted })
      const id = String(created.message_thread_id)
      topics.set(id, wanted)
      yield* Effect.logInfo(`created topic ${wanted} (${id})`)
      return { thread: ThreadId.make(id), created: true }
    }),

  "thread.delete": ({ thread }) =>
    Effect.gen(function*() {
      const s = yield* current()
      yield* telegram("deleteForumTopic", { chat_id: s.config.group, message_thread_id: Number(thread) })
      yield* Effect.logInfo(`deleted topic ${topics.get(thread) ?? thread}`)
      topics.delete(thread)
      return {}
    }),

  "message.post": ({ place, text, files, actions, replyTo, silent }) =>
    Effect.gen(function*() {
      const s = yield* current()
      const quiet = silent === true ? { disable_notification: true } : {}
      const base = {
        ...target(s, place),
        ...quiet,
        ...(replyTo === undefined ? {} : { reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } })
      }
      const markup = actions === undefined ? {} : { reply_markup: keyboard(actions) }
      const all = files ?? []
      let first: TgMessage | undefined
      if (text !== "" || all.length === 0) {
        first = yield* sendText({ ...base, ...markup, link_preview_options: { is_disabled: true } }, text === "" ? " " : text)
      }
      for (const [index, file] of all.entries()) {
        const last = index === all.length - 1
        const sent = yield* sendFile({ ...target(s, place), ...quiet }, file.path, file.name, first === undefined && last ? markup : {})
        first ??= sent
      }
      return { message: MessageId.make(String(first!.message_id)) }
    }),

  "message.edit": ({ place, message, text, actions }) =>
    Effect.gen(function*() {
      const s = yield* current()
      yield* edit({ chat_id: target(s, place).chat_id, message_id: Number(message) }, text, actions)
      return {}
    }),

  react: ({ place, message, emoji }) =>
    Effect.gen(function*() {
      const s = yield* current()
      if (emoji.kind !== "unicode") return {}
      // Bots may only use Telegram's own reaction set: an emoji outside it is skipped.
      yield* telegram("setMessageReaction", {
        chat_id: target(s, place).chat_id,
        message_id: Number(message),
        reaction: [{ type: "emoji", emoji: emoji.value }]
      }).pipe(Effect.catchIf((error) => /REACTION_INVALID/i.test(error.message), () => Effect.void))
      return {}
    }),

  ask: ({ place, text, choices, silent }) =>
    Effect.gen(function*() {
      const s = yield* current()
      const quiet = silent === true ? { disable_notification: true } : {}
      const sent = yield* sendText({ ...target(s, place), ...quiet, reply_markup: keyboard(choices) }, text)
      return { message: MessageId.make(String(sent.message_id)) }
    })
})

// Inbound

const placeOf = (s: Session, message: TgMessage): Place | undefined => {
  if (message.chat.type === "private" && String(message.chat.id) === s.config.owner) return { kind: "direct" }
  if (String(message.chat.id) !== s.config.group) return undefined
  // The General topic carries no thread: nothing of ours lives there.
  if (message.is_topic_message !== true || message.message_thread_id === undefined) return undefined
  return { kind: "thread", thread: ThreadId.make(String(message.message_thread_id)) }
}

const attachments = (message: TgMessage) =>
  Effect.gen(function*() {
    const found: Array<{ ref: FileRef; name: string }> = []
    const photo = message.photo?.at(-1) // the largest size
    if (photo !== undefined) found.push({ ref: photo, name: `photo-${message.message_id}.jpg` })
    for (const [kind, ref] of [["document", message.document], ["video", message.video], ["audio", message.audio], ["voice", message.voice], ["animation", message.animation]] as const) {
      if (ref !== undefined) found.push({ ref, name: ref.file_name ?? `${kind}-${message.message_id}` })
    }
    const out: Array<Attachment> = []
    for (const { ref, name } of found) {
      const size = ref.file_size ?? 0
      if (size > maxDownload) {
        // Too big for a bot to download; the bridge refuses it by size.
        out.push({ name, url: "https://api.telegram.org/too-large", size })
        continue
      }
      const file = yield* telegram<{ file_path?: string }>("getFile", { file_id: ref.file_id })
      if (file.file_path === undefined) continue
      out.push({
        name,
        url: `https://api.telegram.org/file/bot${token}/${file.file_path}`,
        size,
        ...(ref.mime_type === undefined ? {} : { contentType: ref.mime_type })
      })
    }
    return out
  })

const run = Effect.gen(function*() {
  const peer = yield* Peer.make({
    transport: StdioTransport.make(),
    outgoing: AdapterToBridge,
    incoming: BridgeToAdapter,
    handlers
  })

  const onMessage = (s: Session, message: TgMessage) =>
    Effect.gen(function*() {
      if (message.from === undefined || message.from.is_bot || String(message.from.id) !== s.config.owner) return
      const inGroup = String(message.chat.id) === s.config.group
      if (inGroup && message.forum_topic_created !== undefined && message.message_thread_id !== undefined) {
        const thread = String(message.message_thread_id)
        topics.set(thread, message.forum_topic_created.name)
        return yield* peer.notify("thread.created", { thread: ThreadId.make(thread), name: message.forum_topic_created.name })
      }
      if (inGroup && message.forum_topic_edited !== undefined && message.message_thread_id !== undefined) {
        topics.delete(String(message.message_thread_id)) // the next sync puts herdr's name back
        return
      }
      if (inGroup && message.forum_topic_closed !== undefined && message.message_thread_id !== undefined) {
        // Bots never hear of a deleted topic; closing one is how the owner closes its tab.
        const thread = String(message.message_thread_id)
        yield* peer.notify("thread.deleted", { thread: ThreadId.make(thread) })
        yield* telegram("deleteForumTopic", { chat_id: s.config.group, message_thread_id: Number(thread) }).pipe(Effect.ignore)
        topics.delete(thread)
        return
      }
      const place = placeOf(s, message)
      if (place === undefined) return
      const text = message.text ?? message.caption ?? ""

      if (message.text !== undefined && message.entities?.[0]?.type === "bot_command" && message.entities[0].offset === 0) {
        const parsed = parseCommand(text, s.commands, s.me.username ?? "")
        const reply = (answer: string) =>
          sendText({ ...target(s, place), reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } }, answer)
        if (parsed._tag === "usage") return yield* reply(parsed.text).pipe(Effect.asVoid)
        if (parsed._tag === "command") {
          yield* telegram("sendChatAction", { ...target(s, place), action: "typing" }).pipe(Effect.ignore)
          const answer = yield* peer.request("command.invoked", { place, command: parsed.command, args: parsed.args }).pipe(
            Effect.map((result) => result.text),
            Effect.catch((error) => Effect.succeed(`⚠️ ${error.message}`))
          )
          return yield* reply(answer).pipe(Effect.asVoid)
        }
        // /start, /help and other words of the private chat go to the bridge as text.
        if (place.kind === "direct") {
          return yield* peer.notify("message.received", { place, message: MessageId.make(String(message.message_id)), text: "/help", attachments: [] })
        }
      }

      const files = yield* attachments(message)
      const replied = message.reply_to_message
      // In a topic, a message that replies to nothing points at the topic's first message.
      const replyTo = replied === undefined || replied.forum_topic_created !== undefined || replied.message_id === message.message_thread_id
        ? undefined
        : MessageId.make(String(replied.message_id))
      yield* peer.notify("message.received", {
        place,
        message: MessageId.make(String(message.message_id)),
        text,
        attachments: files,
        ...(replyTo === undefined ? {} : { replyTo })
      })
    })

  const onCallback = (s: Session, query: NonNullable<Update["callback_query"]>) =>
    Effect.gen(function*() {
      if (String(query.from.id) !== s.config.owner) {
        return yield* telegram("answerCallbackQuery", { callback_query_id: query.id, text: "This bot answers only its owner." })
      }
      yield* telegram("answerCallbackQuery", { callback_query_id: query.id }).pipe(Effect.ignore)
      const message = query.message
      const data = query.data === undefined ? undefined : (longActions.get(query.data) ?? query.data)
      if (message === undefined || data === undefined || data === "") return
      const place = placeOf(s, message)
      if (place === undefined) return
      yield* peer.notify("action.pressed", {
        place,
        message: MessageId.make(String(message.message_id)),
        action: ActionId.make(data)
      })
    })

  const poll = Effect.gen(function*() {
    let offset = 0
    while (true) {
      const s = session
      if (s === undefined) {
        yield* Effect.sleep("200 millis")
        continue
      }
      const updates = yield* Effect.tryPromise({
        try: (signal) => api<ReadonlyArray<Update>>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, signal),
        catch: (error) => error
      }).pipe(
        Effect.catch((error) => {
          const conflict = error instanceof TelegramError && error.code === 409
          return Effect.logWarning(
            conflict
              ? "another program is reading this bot's updates (a second herdr-link, or a webhook); retrying in 30 s"
              : `getUpdates: ${scrub(String(error instanceof Error ? error.message : error))}; retrying`
          ).pipe(Effect.andThen(Effect.sleep(conflict ? "30 seconds" : "5 seconds")), Effect.as([] as ReadonlyArray<Update>))
        })
      )
      for (const update of updates) {
        offset = update.update_id + 1
        const handled = update.message !== undefined
          ? onMessage(s, update.message)
          : update.callback_query !== undefined
          ? onCallback(s, update.callback_query)
          : Effect.void
        yield* handled.pipe(Effect.catchCause((cause) => Effect.logError(cause)))
      }
    }
  })
  yield* Effect.forkScoped(poll.pipe(Effect.retry(Schedule.spaced("5 seconds"))))

  // A topic the owner deleted: "renaming" it to its own name fails only then
  // (a live one answers TOPIC_NOT_MODIFIED). Its tab then closes, as on Discord.
  const checkTopics = Effect.gen(function*() {
    const s = session
    if (s === undefined) return
    for (const [thread, name] of [...topics]) {
      const gone = yield* telegram("editForumTopic", { chat_id: s.config.group, message_thread_id: Number(thread), name }).pipe(
        Effect.as(false),
        Effect.catch((error) => Effect.succeed(topicGone.test(error.message)))
      )
      if (!gone || topics.get(thread) !== name) continue
      topics.delete(thread)
      yield* Effect.logInfo(`topic ${name} (${thread}) was deleted`)
      yield* peer.notify("thread.deleted", { thread: ThreadId.make(thread) })
    }
  })
  yield* Effect.forkScoped(
    checkTopics.pipe(Effect.catchCause((cause) => Effect.logError(cause)), Effect.repeat(Schedule.spaced(topicCheckEvery)))
  )

  const closed = yield* peer.closed
  yield* Effect.logInfo(`bridge went away (${closed.message}); stopping`)
}).pipe(
  Effect.scoped,
  Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatSimple)]))
)

NodeRuntime.runMain(run)
