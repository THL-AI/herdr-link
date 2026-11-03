/**
 * The bridge core: routes between herdr-core, the agent hooks and the chat
 * adapters, without knowing any platform.
 *
 * - Mirror: herdr is the source of truth. A herdr space becomes a private
 *   room, each of its tabs a thread named after the tab and prefixed with its
 *   agent's emoji.
 * - Owner → agent: a message in a tab's thread is typed into the tab's agent
 *   (`terminal.send`); attachments are put beside it first (`terminal.put`).
 *   A split tab (several panes) shares one thread: the panes sign their
 *   messages; a reply goes to the pane that wrote the message, a leading agent
 *   emoji to that agent, anything else asks "Who is this for?".
 * - Agent → owner: the shared `Stop` hook brings the agent's reply, posted in
 *   the thread. A turn without a hook reply still gets "✅ Done", and
 *   `blocked` gets "⚠️ Needs you".
 * - Closed in herdr: a tab's thread moves to the archive room and is deleted
 *   a week later; a closed space's room is deleted. Deleted by the owner on
 *   the platform: the tab is closed in herdr (its terminals end).
 * - The direct conversation is the control room: a dashboard message edited
 *   as agents change, and quick tasks (pick a space, a new tab starts on it).
 * - Permission prompts (`blocked` with kind `permission`) get Allow / Allow
 *   always / Deny buttons; a press types the agent's configured keys
 *   (`terminal.keys`). The buttons go away once the prompt is answered,
 *   here or in herdr.
 *
 * Rooms and threads made by hand on the platform are never touched.
 *
 * Everything runs in one loop over the merged core and chat events, so the
 * state needs no locks.
 */
import { Clock, Deferred, Duration, Effect, Queue, Stream } from "effect"
import type { Chat, ChatEvent } from "../chat/Chat.ts"
import type { Agent } from "../Config.ts"
import type { CoreEvent } from "../core/Events.ts"
import type { HerdrApp } from "../core/HerdrApp.ts"
import { CoreError, type HerdrCore } from "../core/HerdrCore.ts"
import type { Terminal } from "../core/Methods.ts"
import * as Spaces from "../core/Spaces.ts"
import type { Action, Capabilities, Place } from "../protocol/Chat.ts"
import { ActionId, MessageId, RoomId, ThreadId } from "../protocol/Chat.ts"
import { ErrorCode } from "../protocol/JsonRpc.ts"
import type { AdapterToBridge, Params, Result } from "../protocol/Methods.ts"
import { RpcError } from "../protocol/Peer.ts"
import type { HookMessage, Question } from "./Hooks.ts"
import * as Questions from "./Questions.ts"
import * as Store from "./Store.ts"
import { chunk } from "./Text.ts"

/** Wait this long after `done` for the hook's reply before posting a bare "Done". */
const replyGrace = Duration.seconds(4)
/**
 * A new thread's tab starts this long after the thread appears, so a message
 * written with it (Telegram creates a topic only with its first message)
 * becomes the agent's first task instead of getting lost.
 */
const firstMessageGrace = Duration.seconds(2)
/** How long a question waits for the hook's copy of its form before it is posted as plain text. */
const questionGrace = Duration.millis(1500)
/** Between keys that change the form's screen and the next ones. */
const formSettle = Duration.millis(400)
/** A turn gets a status message once it has run this long (quick answers need none). */
const showProgressAfter = 45_000
/** The agent's latest notes shown in it, and their length. */
const keptNotes = 3
const maxNote = 160
interface Posted {
  readonly adapter: string
  readonly place: Place
  readonly message: MessageId
}

const helpText = [
  "This is the control room.",
  "• Write a task here: I ask in which space, then open a new tab whose agent starts on it " +
  "(start with an agent's emoji to pick one, e.g. ⚪ for grok).",
  "• My status message here is edited live with what every agent is doing; `/status` posts a fresh copy.",
  "• `/status`, `/space new`, and in a tab's channel `/screen`. Whatever you write in a tab's channel goes to its agent.",
  "• A new channel in a space's category opens a new tab there."
].join("\n")

const stateIcon: Record<string, string> = { working: "⏳", done: "✅", blocked: "⚠️", idle: "💤", error: "❌" }

/** A tab name from a task: its first words. */
export const slug = (task: string) =>
  task.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 3).join("-").slice(0, 24) || "task"

/** Where threads of closed tabs wait before they are deleted. */
const archiveBase = "📦 archive"
const keepArchived = 7 // days
/** Below Discord's 50 channels per category. */
const maxArchived = 45
const sweepEvery = Duration.hours(1)

/** herdr-core's limit for `terminal.put`. */
const maxFileBytes = 8 * 1024 * 1024

type Agents = Readonly<Record<string, Agent>>

/** Which configured agent runs in this terminal, if any. */
export const agentOf = (agents: Agents, terminal: Terminal): string | undefined => {
  const entries = Object.entries(agents)
  const byTemplate = terminal.template == null
    ? undefined
    : entries.find(([, agent]) => agent.template === terminal.template)
  if (byTemplate) return byTemplate[0]
  const app = terminal.status?.app
  const byApp = app === undefined ? undefined : entries.find(([name]) => app === name || app.startsWith(`${name}-`))
  if (byApp) return byApp[0]
  const program = (terminal.foreground?.argv[0] ?? "").split("/").at(-1)
  const byProgram = entries.find(([name, agent]) => program === name || program === agent.argv?.[0])
  return byProgram?.[0]
}

const truncate = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

export const statusText = (state: string, status: Terminal["status"]): string | undefined => {
  const msg = status?.msg === undefined || status.msg === "" ? "" : `: ${status.msg}`
  if (state === "done") return `✅ Done${msg}`
  if (state === "blocked") {
    const kind = status?.kind == null ? "" : ` (${status.kind})`
    return `⚠️ Needs you${kind}${msg}`
  }
  return undefined
}

export const run = Effect.fnUntraced(function*(options: {
  readonly chat: Chat["Service"]
  readonly core: HerdrCore["Service"]
  readonly hooks: Stream.Stream<HookMessage>
  readonly agents: Agents
  /** This computer's name, from the config; added to room names. */
  readonly machine?: string
  /** herdr-app: tabs and spaces live in the app, not in the core. */
  readonly app: HerdrApp
  /** How often the direct-conversation dashboard may be edited; off when omitted. */
  readonly dashboardEvery?: Duration.Input
  /** Adapters whose direct conversation gets no live dashboard (`dashboard = false`). */
  readonly withoutDashboard?: ReadonlyArray<string>
  /** How often a working agent's status message may be edited; off when omitted. */
  readonly progressEvery?: Duration.Input
  /** True while the owner is at the computer: new messages go out without a push. */
  readonly atDesk?: () => boolean
}) {
  const { core, agents } = options
  const atDesk = options.atDesk ?? (() => false)
  /** The adapters, with new messages and questions marked silent while the owner is at the desk. */
  const chat: Chat["Service"] = {
    ...options.chat,
    call: (adapter, method, params) =>
      options.chat.call(
        adapter,
        method,
        (method === "message.post" || method === "ask") && atDesk() ? { ...params, silent: true } : params
      )
  }
  /** Inputs the bridge schedules for itself (a new thread's tab, started a moment later). */
  const later = yield* Queue.unbounded<Input>()
  /** "api", "api · laptop" (this bridge's machine), or "api · build-box" (a space on another herdr machine). */
  const roomName = (space: Spaces.Space) => {
    const machine = space.machine ?? options.machine
    const name = shownName(space)
    return machine === undefined ? name : `${name} · ${machine}`
  }
  /**
   * The space's name as herdr-app shows it. An unnamed one is called after
   * where its first terminal is now (its repo, else its folder) and follows
   * it; herdr-app writes that into each terminal's `where` label
   * ("ram / main").
   */
  const shownName = (space: Spaces.Space) => {
    if (space.named || space.machine !== undefined) return space.name
    for (const tab of space.tabs) {
      for (const address of tab.terminals) {
        const where = terminals.get(address)?.labels["where"]
        if (where === undefined) continue
        const suffix = ` / ${tab.name}`
        const name = where.endsWith(suffix) ? where.slice(0, -suffix.length) : where.split(" / ")[0]
        if (name !== undefined && name.trim() !== "") return name.trim()
      }
    }
    return space.name
  }
  const archiveName = options.machine === undefined ? archiveBase : `${archiveBase} · ${options.machine}`
  /** When each terminal's last hook reply arrived (ms). */
  const lastReply = new Map<string, number>()
  const adapters = new Map<string, Capabilities>()
  const terminals = new Map<string, Terminal>()
  let spaces: ReadonlyArray<Spaces.Space> = []
  let store: Store.Store | undefined

  const loadStore = Effect.gen(function*() {
    if (store === undefined) store = yield* Store.load(core)
    return store
  })

  const loadSpaces = core.call("doc.get", { name: Spaces.docName }).pipe(
    Effect.flatMap(({ value }) => Spaces.decode(value)),
    Effect.tap((loaded) => Effect.sync(() => (spaces = loaded))),
    Effect.catch((error) => Effect.logWarning(`cannot read herdr spaces: ${error.message}`))
  )

  const emojiOfTab = (tab: Spaces.Tab): string | undefined => {
    for (const address of tab.terminals) {
      const terminal = terminals.get(address)
      const agent = terminal === undefined ? undefined : agentOf(agents, terminal)
      if (agent !== undefined) return agents[agent]?.emoji
    }
    return undefined
  }

  const syncAdapter = (adapter: string) =>
    Effect.gen(function*() {
      const capabilities = adapters.get(adapter)
      if (capabilities === undefined) return
      // Without rooms, every tab is a top-level thread named after its space too.
      const withRooms = capabilities.rooms
      const s = yield* loadStore
      const before = s.state()
      const mine = before.adapters[adapter] ?? Store.emptyAdapter
      const rooms = { ...mine.rooms }
      const threads = { ...mine.threads }
      const archive = { ...(mine.archive ?? { threads: {} }), threads: { ...mine.archive?.threads } }

      for (const space of spaces) {
        const known = rooms[space.id]
        const room = withRooms
          ? (yield* chat.call(adapter, "room.ensure", {
            name: roomName(space),
            ...(known === undefined ? {} : { room: RoomId.make(known) })
          })).room
          : undefined
        if (room !== undefined) rooms[space.id] = room
        for (const tab of space.tabs) {
          const entry = threads[tab.id]
          const emoji = emojiOfTab(tab) ?? entry?.emoji
          const result = yield* chat.call(adapter, "thread.ensure", {
            ...(room === undefined ? {} : { room }),
            name: withRooms ? `${emoji ?? ""}${tab.name}` : `${emoji ?? ""}${roomName(space)} / ${tab.name}`,
            topic: `${roomName(space)} / ${tab.name} — ${space.folder}`,
            ...(entry === undefined ? {} : { thread: ThreadId.make(entry.thread) })
          })
          threads[tab.id] = emoji === undefined ? { thread: result.thread } : { thread: result.thread, emoji }
        }
      }

      // Tabs and spaces closed in herdr. An empty layout is more likely a glitch
      // (the app restarting) than everything closed: then nothing is archived.
      if (spaces.length > 0) {
        const liveTabs = new Set(spaces.flatMap((space) => space.tabs.map((tab) => tab.id)))
        for (const [tabId, entry] of Object.entries(threads)) {
          if (liveTabs.has(tabId)) continue
          delete threads[tabId]
          if (!withRooms) {
            // Nowhere to archive it: the thread goes now.
            yield* chat.call(adapter, "thread.delete", { thread: ThreadId.make(entry.thread) }).pipe(Effect.ignore)
            yield* Effect.logInfo(`deleted the thread of closed tab ${tabId}`)
            continue
          }
          const archiveRoom = yield* chat.call(adapter, "room.ensure", {
            name: archiveName,
            ...(archive.room === undefined ? {} : { room: RoomId.make(archive.room) })
          })
          archive.room = archiveRoom.room
          const moved = yield* chat.call(adapter, "thread.ensure", {
            room: archiveRoom.room,
            thread: ThreadId.make(entry.thread),
            topic: `closed in herdr; deleted after ${keepArchived} days`
          }).pipe(Effect.option) // already deleted by hand: nothing to keep
          if (moved._tag === "Some") archive.threads[entry.thread] = { tab: tabId, archivedAt: yield* Clock.currentTimeMillis }
          yield* Effect.logInfo(`archived the thread of closed tab ${tabId}`)
        }
        const liveSpaces = new Set(spaces.map((space) => space.id))
        for (const [spaceId, room] of Object.entries(rooms)) {
          if (liveSpaces.has(spaceId)) continue
          delete rooms[spaceId]
          yield* chat.call(adapter, "room.delete", { room: RoomId.make(room) }).pipe(Effect.ignore)
          yield* Effect.logInfo(`deleted the room of closed space ${spaceId}`)
        }
      }

      yield* sweepArchive(adapter, archive)
      const keepArchive = archive.room !== undefined || Object.keys(archive.threads).length > 0
      const next: Store.State = {
        // `...mine` keeps what the sync doesn't own (the dashboard's message).
        adapters: {
          ...before.adapters,
          [adapter]: keepArchive ? { ...mine, rooms, threads, archive } : { ...withoutArchive(mine), rooms, threads }
        }
      }
      if (JSON.stringify(next) !== JSON.stringify(before)) yield* s.save(next)
      yield* Effect.logInfo(`${adapter}: synced ${spaces.length} spaces`)
    }).pipe(
      Effect.catch((error) => Effect.logWarning(`${adapter}: sync failed: ${error.message}`)),
      Effect.annotateLogs({ adapter })
    )

  const withoutArchive = ({ archive: _, ...rest }: Store.AdapterState) => rest

  /** Deletes archived threads older than a week, and the oldest beyond the room's capacity. Mutates `archive`. */
  const sweepArchive = (adapter: string, archive: Store.Archive & { threads: Record<string, unknown> }) =>
    Effect.gen(function*() {
      const entries = Object.entries(archive.threads).sort(([, a], [, b]) => a.archivedAt - b.archivedAt)
      const cutoff = (yield* Clock.currentTimeMillis) - Duration.toMillis(Duration.days(keepArchived))
      const overflow = Math.max(0, entries.length - maxArchived)
      for (const [index, [thread, entry]] of entries.entries()) {
        if (entry.archivedAt > cutoff && index >= overflow) continue
        // Forget it first, so the deletion is not mistaken for the owner's.
        delete (archive.threads as Record<string, unknown>)[thread]
        yield* chat.call(adapter, "thread.delete", { thread: ThreadId.make(thread) }).pipe(Effect.ignore)
        yield* Effect.logInfo(`deleted archived thread ${thread}`)
      }
    })

  /** A periodic sweep outside a sync. */
  const sweepAll = Effect.gen(function*() {
    const s = yield* loadStore
    for (const adapter of adapters.keys()) {
      const state = s.state()
      const mine = state.adapters[adapter]
      if (mine?.archive === undefined) continue
      const archive = { ...mine.archive, threads: { ...mine.archive.threads } }
      yield* sweepArchive(adapter, archive)
      if (Object.keys(archive.threads).length !== Object.keys(mine.archive.threads).length) {
        yield* s.save({ adapters: { ...state.adapters, [adapter]: { ...mine, archive } } })
      }
    }
  }).pipe(Effect.catch((error) => Effect.logWarning(`archive sweep failed: ${error.message}`)))

  /**
   * The owner deleted a thread: its tab goes too (Deleted channel → close the
   * tab). An archived thread is just forgotten.
   */
  const threadDeleted = (adapter: string, thread: string) =>
    Effect.gen(function*() {
      const s = yield* loadStore
      const state = s.state()
      const mine = state.adapters[adapter]
      if (mine === undefined) return
      if (mine.archive?.threads[thread] !== undefined) {
        const { [thread]: _, ...rest } = mine.archive.threads
        return yield* s.save({ adapters: { ...state.adapters, [adapter]: { ...mine, archive: { ...mine.archive, threads: rest } } } })
      }
      const tabId = Object.entries(mine.threads).find(([, entry]) => entry.thread === thread)?.[0]
      if (tabId === undefined) return
      const { [tabId]: _, ...threads } = mine.threads
      yield* s.save({ adapters: { ...state.adapters, [adapter]: { ...mine, threads } } })
      const tab = spaces.flatMap((space) => space.tabs).find((t) => t.id === tabId)
      yield* Effect.logInfo(`${adapter}: thread of tab ${tab?.name ?? tabId} deleted; closing the tab`)
      yield* options.app.closeTab(tabId).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`cannot close tab ${tabId} in herdr-app (${error.message}); ending its terminals`).pipe(
            Effect.andThen(Effect.forEach(
              tab?.terminals ?? [],
              (terminal) => core.call("terminal.kill", { terminal }).pipe(Effect.ignore),
              { discard: true }
            ))
          )
        )
      )
    }).pipe(Effect.catch((error) => Effect.logWarning(`cannot handle a deleted thread: ${error.message}`)))

  const syncAll = Effect.suspend(() => Effect.forEach([...adapters.keys()], syncAdapter, { discard: true }))

  const tabOf = (address: string) => {
    for (const space of spaces) {
      for (const tab of space.tabs) if (tab.terminals.includes(address)) return tab
    }
    return undefined
  }

  // Split tabs: several panes (terminals) share one thread.

  /** A tab's live terminals, in layout order. */
  const liveTerminals = (tab: Spaces.Tab) =>
    tab.terminals.flatMap((address) => {
      const terminal = terminals.get(address)
      return terminal !== undefined && terminal.state === "live" ? [terminal] : []
    })

  /** "✳️ claude", or "▫️ zsh" for a program that is no agent; numbered when two panes look alike. */
  const paneLabel = (address: string) => {
    const label = (a: string) => {
      const terminal = terminals.get(a)
      const agent = terminal === undefined ? undefined : agentOf(agents, terminal)
      if (agent !== undefined) return `${agents[agent]!.emoji} ${agent}`
      return `▫️ ${terminal?.foreground?.name ?? terminal?.argv[0]?.split("/").at(-1) ?? a}`
    }
    const own = label(address)
    const tab = tabOf(address)
    const alike = (tab === undefined ? [] : liveTerminals(tab)).filter((t) => label(t.address) === own)
    return alike.length > 1 ? `${own} ${alike.findIndex((t) => t.address === address) + 1}` : own
  }

  /** Says which pane is speaking, when its tab has more than one. */
  const speaker = (address: string, text: string) => {
    const tab = tabOf(address)
    return tab !== undefined && liveTerminals(tab).length > 1 ? `${paneLabel(address)} · ${text}` : text
  }

  /** Which pane posted which message, so a reply goes back to it. The latest ones only. */
  const postedBy = new Map<string, string>()
  const rememberPost = (message: string, address: string) => {
    postedBy.set(message, address)
    if (postedBy.size > 2000) postedBy.delete(postedBy.keys().next().value!)
  }

  /**
   * Posts `text` in the thread of the tab holding this terminal, on every
   * adapter; `actions` go under the last part. Returns where it landed.
   */
  const postToTab = (address: string, text: string, actions?: ReadonlyArray<Action>) =>
    Effect.gen(function*() {
      const posted: Array<Posted> = []
      const tab = tabOf(address)
      if (tab === undefined) return posted
      const s = yield* loadStore
      for (const [adapter, capabilities] of adapters) {
        const entry = s.state().adapters[adapter]?.threads[tab.id]
        if (entry === undefined) continue
        const place: Place = { kind: "thread", thread: ThreadId.make(entry.thread) }
        const parts = chunk(text, capabilities.maxText)
        yield* Effect.forEach(parts, (part, index) => {
          const withActions = actions !== undefined && capabilities.actions && index === parts.length - 1
          return chat.call(adapter, "message.post", { place, text: part, ...(withActions ? { actions } : {}) }).pipe(
            Effect.tap(({ message }) =>
              Effect.sync(() => {
                posted.push({ adapter, place, message })
                rememberPost(message, address)
              })
            )
          )
        }, { discard: true }).pipe(Effect.catch((error) => Effect.logWarning(`${adapter}: cannot post: ${error.message}`)))
      }
      return posted
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`cannot post to the tab of ${address}: ${error.message}`).pipe(Effect.as([] as Array<Posted>))
      )
    )

  // Permission prompts: one open prompt per terminal, answered by a button or in herdr.

  interface Prompt {
    readonly id: number
    readonly address: string
    readonly text: string
    /** A "trust this folder?" question (Grok): only the agent's `trust` keys answer it. */
    readonly trust: boolean
    readonly posted: ReadonlyArray<Posted>
  }
  const prompts = new Map<string, Prompt>()
  const isTrustQuestion = (msg: string | undefined) => msg !== undefined && /\btrust\b.*\?/i.test(msg)
  let nextPrompt = 1

  const choices = {
    allow: { label: "Allow", style: "success", outcome: "✅ Allowed" },
    always: { label: "Allow always", style: "primary", outcome: "✅ Allowed (always)" },
    deny: { label: "Deny", style: "danger", outcome: "❌ Denied: write what to do instead" }
  } as const
  type Choice = keyof typeof choices

  const keysFor = (address: string, choice: Choice, trust: boolean): ReadonlyArray<string> | undefined => {
    const terminal = terminals.get(address)
    const agent = terminal === undefined ? undefined : agentOf(agents, terminal)
    const config = agent === undefined ? undefined : agents[agent]
    if (trust) return choice === "allow" ? config?.trust : undefined
    return config?.[choice]
  }

  const openPrompt = (address: string, status: Terminal["status"]) =>
    Effect.gen(function*() {
      const open = prompts.get(address)
      if (open !== undefined) return
      const id = nextPrompt++
      const trust = isTrustQuestion(status?.msg)
      const text = speaker(address, `🔐 Permission: ${status?.msg ?? "the agent asks for permission"}`)
      const actions: Array<Action> = (["allow", "always", "deny"] as const)
        .filter((choice) => keysFor(address, choice, trust) !== undefined)
        .map((choice) => ({
          id: ActionId.make(`prompt:${id}:${choice}`),
          label: trust ? "Trust" : choices[choice].label,
          style: choices[choice].style
        }))
      const note = actions.length === 0 ? "\n(answer it in herdr)" : trust ? "\n(to refuse, answer it in herdr)" : ""
      const posted = yield* postToTab(address, `${text}${note}`, actions)
      prompts.set(address, { id, address, text, trust, posted })
    })

  const closePrompt = (prompt: Prompt, outcome: string) =>
    Effect.gen(function*() {
      prompts.delete(prompt.address)
      yield* Effect.forEach(prompt.posted, ({ adapter, place, message }) =>
        chat.call(adapter, "message.edit", { place, message, text: `${prompt.text}\n→ ${outcome}`, actions: [] }).pipe(
          Effect.catch((error) => Effect.logWarning(`${adapter}: cannot update the prompt: ${error.message}`))
        ), { discard: true })
    })

  const answerPrompt = (adapter: string, params: Params<AdapterToBridge["action.pressed"]>) =>
    Effect.gen(function*() {
      const match = /^prompt:(\d+):(allow|always|deny)$/.exec(params.action)
      if (match === null) return
      const id = Number(match[1])
      const choice = match[2] as Choice
      const prompt = [...prompts.values()].find((p) => p.id === id)
      if (prompt === undefined) {
        // Answered already, or from before a restart: just drop the stale buttons.
        return yield* chat.call(adapter, "message.edit", { place: params.place, message: params.message, actions: [] }).pipe(
          Effect.ignore
        )
      }
      const keys = keysFor(prompt.address, choice, prompt.trust)
      if (keys === undefined) return
      yield* core.call("terminal.keys", { terminal: prompt.address, keys: [...keys] }).pipe(
        Effect.andThen(closePrompt(prompt, choices[choice].outcome)),
        Effect.catch((error) =>
          chat.call(adapter, "message.post", {
            place: params.place,
            text: `⚠️ ${describeCoreError(error)}`,
            replyTo: params.message
          }).pipe(Effect.ignore)
        )
      )
    })

  // Question forms (AskUserQuestion): the hook brings the questions, the status says the
  // form is on screen; one message per question, answered with the form's keys.

  interface Form {
    readonly id: number
    readonly address: string
    readonly questions: ReadonlyArray<Question>
    step: number
    picked: Set<number>
    /** The current question's message. */
    posted: ReadonlyArray<Posted>
    text: string
  }
  /** The questions of each terminal's latest AskUserQuestion, until its form opens. */
  const asked = new Map<string, ReadonlyArray<Question>>()
  const forms = new Map<string, Form>()
  let nextForm = 1

  const isQuestionOnScreen = (address: string) => {
    const status = terminals.get(address)?.status
    return status?.state === "blocked" && status.kind === "question"
  }

  /** An answered question no longer needs its "tap one…" line. */
  const withoutHint = (text: string) => text.replace(/\n\n-# [^\n]*$/, "")

  const editForm = (posted: ReadonlyArray<Posted>, text: string, actions?: ReadonlyArray<Action>) =>
    Effect.forEach(posted, ({ adapter, place, message }) =>
      chat.call(adapter, "message.edit", { place, message, text, actions: actions ?? [] }).pipe(
        Effect.catch((error) => Effect.logWarning(`${adapter}: cannot update the question: ${error.message}`))
      ), { discard: true })

  const postStep = (form: Form) =>
    Effect.gen(function*() {
      form.text = speaker(form.address, Questions.text(form.questions, form.step))
      form.posted = yield* postToTab(form.address, form.text, Questions.actions(form.id, form.questions, form.step, form.picked))
    })

  const openForm = (address: string) =>
    Effect.gen(function*() {
      const questions = asked.get(address)
      if (questions === undefined || forms.has(address)) return
      asked.delete(address)
      const form: Form = { id: nextForm++, address, questions, step: 0, picked: new Set(), posted: [], text: "" }
      forms.set(address, form)
      yield* postStep(form)
    })

  /** The status says a question is on screen: the form, or (no hook copy) the plain status. */
  const questionShown = (address: string, status: Terminal["status"]) =>
    Effect.gen(function*() {
      if (forms.has(address)) return
      if (asked.has(address)) return yield* openForm(address)
      const text = statusText("blocked", status)
      if (text !== undefined) yield* postToTab(address, speaker(address, text))
    })

  const closeForm = (form: Form, outcome: string) =>
    Effect.gen(function*() {
      forms.delete(form.address)
      yield* editForm(form.posted, `${withoutHint(form.text)}\n→ ${outcome}`)
    })

  /** Keys into the form, in the background (the screen needs a moment between steps). */
  const formKeys = (address: string, steps: ReadonlyArray<ReadonlyArray<string>>, then?: Effect.Effect<void, CoreError>) =>
    Effect.gen(function*() {
      for (const [index, keys] of steps.entries()) {
        if (index > 0) yield* Effect.sleep(formSettle)
        yield* core.call("terminal.keys", { terminal: address, keys: [...keys] })
      }
      if (then !== undefined) yield* Effect.sleep(formSettle).pipe(Effect.andThen(then))
    }).pipe(
      Effect.catch((error) => Effect.logWarning(`cannot answer the question in ${address}: ${error.message}`)),
      Effect.forkScoped
    )

  /** The current question is answered (its keys already typed): show it, go on, submit at the end. */
  const advance = (
    form: Form,
    answer: string,
    steps: ReadonlyArray<ReadonlyArray<string>>,
    then?: Effect.Effect<void, CoreError>
  ) =>
    Effect.gen(function*() {
      yield* editForm(form.posted, `${withoutHint(form.text)}\n→ ${answer}`)
      form.step++
      form.picked = new Set()
      const done = form.step >= form.questions.length
      const submit = done && Questions.needsReview(form.questions) ? [["1"]] : []
      if (done) forms.delete(form.address)
      yield* formKeys(form.address, [...steps, ...submit], then)
      if (!done) yield* postStep(form)
    })

  const answerQuestion = (adapter: string, params: Params<AdapterToBridge["action.pressed"]>) =>
    Effect.gen(function*() {
      const parsed = Questions.parseAction(params.action)
      if (parsed === undefined) return
      const form = [...forms.values()].find((f) => f.id === parsed.form)
      if (form === undefined || form.step !== parsed.step) {
        // Answered already, or from before a restart: just drop the stale buttons.
        return yield* chat.call(adapter, "message.edit", { place: params.place, message: params.message, actions: [] }).pipe(
          Effect.ignore
        )
      }
      const question = form.questions[form.step]!
      if (parsed.choice === "next") {
        const labels = [...form.picked].sort((a, b) => a - b).map((i) => question.options[i]!.label)
        return yield* advance(form, labels.length === 0 ? "(none)" : labels.join(", "), [["tab"]])
      }
      const option = question.options[parsed.choice]
      if (option === undefined) return
      if (!question.multiSelect) return yield* advance(form, option.label, Questions.pickSteps(question, parsed.choice))
      if (form.picked.has(parsed.choice)) form.picked.delete(parsed.choice)
      else form.picked.add(parsed.choice)
      yield* formKeys(form.address, [[Questions.optionKey(parsed.choice)]])
      yield* editForm(form.posted, form.text, Questions.actions(form.id, form.questions, form.step, form.picked))
    })

  /** The owner wrote while the form is open: their own answer, or (multi select, previews) a message instead. */
  const answerInWords = (form: Form, text: string) =>
    Effect.gen(function*() {
      const question = form.questions[form.step]!
      const send = core.call("terminal.send", { terminal: form.address, text, force: true }).pipe(Effect.asVoid)
      if (Questions.takesWords(question)) return yield* advance(form, text, [[Questions.ownWordsKey(question)]], send)
      yield* closeForm(form, "closed; your message went to the agent")
      yield* formKeys(form.address, [["esc"]], send)
    })

  /** The tab whose thread this is, for this adapter. */
  const tabOfThread = (s: Store.Store, adapter: string, thread: string) => {
    const threads = s.state().adapters[adapter]?.threads ?? {}
    const tabId = Object.entries(threads).find(([, entry]) => entry.thread === thread)?.[0]
    if (tabId === undefined) return undefined
    for (const space of spaces) for (const tab of space.tabs) if (tab.id === tabId) return tab
    return undefined
  }

  /** The tab's agent terminal, else its first live terminal. */
  const terminalOfTab = (tab: Spaces.Tab) => {
    const live = tab.terminals.map((a) => terminals.get(a)).filter((t) => t !== undefined && t.state === "live")
    return (live.find((t) => agentOf(agents, t!) !== undefined) ?? live[0])?.address
  }

  const describeCoreError = (error: CoreError) => {
    switch (error.kind) {
      case "blocked":
        return "The agent is waiting on a prompt on its screen; answer that first."
      case "finished":
        return "The program in this tab has exited."
      case "not_found":
        return "That terminal is gone."
      default:
        return `herdr-core: ${error.message}`
    }
  }

  const putAttachment = (terminal: string, attachment: Params<AdapterToBridge["message.received"]>["attachments"][number]) =>
    Effect.gen(function*() {
      if ((attachment.size ?? 0) > maxFileBytes) return `${attachment.name}: too large (max 8 MB)`
      const bytes = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(attachment.url)
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return new Uint8Array(await response.arrayBuffer())
        },
        catch: (cause) => new Error(`cannot download ${attachment.name}: ${String(cause)}`)
      })
      if (bytes.length > maxFileBytes) return `${attachment.name}: too large (max 8 MB)`
      const put = yield* core.call("terminal.put", {
        terminal,
        name: attachment.name,
        data: Buffer.from(bytes).toString("base64")
      })
      return put.path
    })

  const forward = (adapter: string, params: Params<AdapterToBridge["message.received"]>) =>
    Effect.gen(function*() {
      const reply = (text: string) =>
        chat.call(adapter, "message.post", { place: params.place, text, replyTo: params.message }).pipe(Effect.ignore)
      if (params.place.kind === "direct") {
        const text = params.text.trim()
        const answer = text === "" || /^(help|\?|\/help)$/i.test(text) ? helpText : yield* askWhere(adapter, params, text)
        return answer === undefined ? undefined : yield* reply(answer)
      }
      const early = firstMessages.get(threadKey(adapter, params.place.thread))
      if (early !== undefined) {
        // The thread's tab is not up yet: this becomes its agent's first task.
        early.push(params.text)
        return yield* chat.call(adapter, "react", {
          place: params.place,
          message: MessageId.make(params.message),
          emoji: { kind: "unicode", value: "👀" }
        }).pipe(Effect.ignore)
      }
      const s = yield* loadStore
      const tab = tabOfThread(s, adapter, params.place.thread)
      if (tab === undefined) return // not one of ours: the owner's other channels
      const live = liveTerminals(tab)
      if (live.length === 0) return yield* reply("No live terminal in this tab.")

      // Which pane: the one whose message this replies to, the agent named by a leading
      // emoji, the only one; else ask.
      const repliedTo = params.replyTo === undefined ? undefined : postedBy.get(params.replyTo)
      const named = agentFromName(params.text.trim())
      const byEmoji = named === undefined ? undefined : live.find((t) => agentOf(agents, t) === named.agent)
      const target = live.find((t) => t.address === repliedTo)?.address ??
        byEmoji?.address ??
        (live.length === 1 ? live[0]!.address : undefined)
      if (target === undefined) return yield* askWhom(adapter, params, live.map((t) => t.address))
      const form = forms.get(target)
      if (form !== undefined && params.text.trim() !== "") {
        yield* answerInWords(form, byEmoji !== undefined && target === byEmoji.address ? named!.rest : params.text.trim())
        return yield* chat.call(adapter, "react", {
          place: params.place,
          message: MessageId.make(params.message),
          emoji: { kind: "unicode", value: "👀" }
        }).pipe(Effect.ignore)
      }
      yield* deliver(adapter, params, target, byEmoji !== undefined && target === byEmoji.address ? named!.rest : params.text)
    }).pipe(Effect.catch((error) => replyError(adapter, params, error)))

  const replyError = (adapter: string, params: Params<AdapterToBridge["message.received"]>, error: Error) =>
    chat.call(adapter, "message.post", {
      place: params.place,
      text: `⚠️ ${error instanceof CoreError ? describeCoreError(error) : error.message}`,
      replyTo: params.message
    }).pipe(Effect.ignore)

  /** Types the owner's message (and files) into a terminal, then marks the message seen. */
  const deliver = (
    adapter: string,
    params: Params<AdapterToBridge["message.received"]>,
    terminal: string,
    message: string
  ) =>
    Effect.gen(function*() {
      const files = yield* Effect.forEach(params.attachments, (a) => putAttachment(terminal, a))
      const text = [message.trim(), ...files.map((f) => `[file: ${f}]`)].filter((p) => p !== "").join("\n")
      if (text === "") return
      yield* core.call("terminal.send", { terminal, text })
      yield* chat.call(adapter, "react", {
        place: params.place,
        message: MessageId.make(params.message),
        emoji: { kind: "unicode", value: "👀" }
      }).pipe(Effect.ignore)
    })

  interface PendingSend {
    readonly adapter: string
    readonly params: Params<AdapterToBridge["message.received"]>
  }
  const pendingSends = new Map<number, PendingSend>()
  let nextSend = 1

  const askWhom = (adapter: string, params: Params<AdapterToBridge["message.received"]>, panes: ReadonlyArray<string>) =>
    Effect.gen(function*() {
      const id = nextSend++
      pendingSends.set(id, { adapter, params })
      yield* chat.call(adapter, "ask", {
        place: params.place,
        text: "Who is this for?",
        choices: panes.map((address) => ({ id: ActionId.make(`send:${id}:${address}`), label: paneLabel(address) })) as never
      })
    })

  const answerSend = (adapter: string, params: Params<AdapterToBridge["action.pressed"]>) =>
    Effect.gen(function*() {
      const match = /^send:(\d+):(.+)$/.exec(params.action)
      if (match === null) return
      const pending = pendingSends.get(Number(match[1]))
      const address = match[2]!
      const edit = (text?: string) =>
        chat.call(adapter, "message.edit", {
          place: params.place,
          message: params.message,
          actions: [],
          ...(text === undefined ? {} : { text })
        }).pipe(Effect.ignore)
      if (pending === undefined || terminals.get(address)?.state !== "live") return yield* edit()
      pendingSends.delete(Number(match[1]))
      yield* edit(`Who is this for? → ${paneLabel(address)}`)
      yield* deliver(pending.adapter, pending.params, address, pending.params.text).pipe(
        Effect.catch((error) => replyError(pending.adapter, pending.params, error))
      )
    })

  // New tabs from the platform: a thread made by the owner in one of our rooms.

  /** The command that starts this agent: its argv, else its template's name as a program. */
  const agentArgv = (agent: Agent) => agent.argv ?? [agent.template ?? "zsh"]

  /** A known agent emoji at the start of a thread name (`✳️api`), and the rest of the name. */
  const agentFromName = (name: string) => {
    const bare = (text: string) => text.replace(/\uFE0F/g, "")
    for (const [agent, config] of Object.entries(agents)) {
      const emoji = bare(config.emoji)
      if (bare(name).startsWith(emoji)) {
        const rest = bare(name).slice(emoji.length).replace(/^[-_\s]+/, "")
        return { agent, rest }
      }
    }
    return undefined
  }

  interface PendingTab {
    readonly adapter: string
    readonly spaceId: string
    readonly thread: string
    readonly name: string
  }
  const pendingTabs = new Map<number, PendingTab>()
  let nextPending = 1

  /** `quiet`: the adapter named the agent itself (a program), so no "is starting" post. */
  const startTab = (adapter: string, spaceId: string, thread: string, agentName: string, tabName: string, quiet = false) =>
    Effect.gen(function*() {
      const place: Place = { kind: "thread", thread: ThreadId.make(thread) }
      const space = spaces.find((sp) => sp.id === spaceId)
      const agent = agents[agentName]
      const task = takeFirstMessages(adapter, thread)
      if (space === undefined || agent === undefined) return
      const created = yield* options.app.newTab({
        space: space.id,
        name: tabName,
        folder: space.folder,
        argv: agentArgv(agent),
        ...(task === undefined ? {} : { task })
      }).pipe(
        Effect.catch((error) =>
          chat.call(adapter, "message.post", { place, text: `⚠️ Cannot open a tab in herdr: ${error.message}` }).pipe(
            Effect.ignore,
            Effect.as(undefined)
          )
        )
      )
      if (created?.tab === undefined) return
      // Link the thread before the layout change arrives, so the sync reuses it.
      const s = yield* loadStore
      const state = s.state()
      const mine = state.adapters[adapter] ?? Store.emptyAdapter
      yield* s.save({
        adapters: {
          ...state.adapters,
          [adapter]: { ...mine, threads: { ...mine.threads, [created.tab]: { thread, emoji: agent.emoji } } }
        }
      })
      if (quiet) return
      yield* chat.call(adapter, "message.post", { place, text: `${agent.emoji} ${agentName} is starting in ${roomName(space)} / ${tabName}.` }).pipe(
        Effect.ignore
      )
    })

  /** Messages written in a new thread before its tab is up: they become the agent's first task. */
  const firstMessages = new Map<string, Array<string>>()
  const threadKey = (adapter: string, thread: string) => `${adapter}\u0000${thread}`
  const takeFirstMessages = (adapter: string, thread: string) => {
    const texts = firstMessages.get(threadKey(adapter, thread))
    firstMessages.delete(threadKey(adapter, thread))
    const task = (texts ?? []).join("\n\n").trim()
    return task === "" ? undefined : task
  }

  /**
   * A new thread in a known space: the adapter's `agent` starts at once; else a
   * leading agent emoji picks the agent, else ask.
   */
  const openTabFor = (adapter: string, spaceId: string, thread: string, name: string, agent?: string) =>
    Effect.gen(function*() {
      if (agent !== undefined) {
        if (agents[agent] !== undefined) return yield* startTab(adapter, spaceId, thread, agent, name, true)
        return yield* chat.call(adapter, "message.post", {
          place: { kind: "thread", thread: ThreadId.make(thread) },
          text: `⚠️ No agent named ${agent} here; the agents are ${Object.keys(agents).join(", ")}.`
        }).pipe(Effect.asVoid)
      }
      const found = agentFromName(name)
      if (found !== undefined) {
        // Started a moment later, so a message that comes with the thread is its task.
        const start: Input = { from: "start", adapter, spaceId, thread, agent: found.agent, name: found.rest || found.agent }
        return yield* Effect.sleep(firstMessageGrace).pipe(Effect.andThen(Queue.offer(later, start)), Effect.forkScoped, Effect.asVoid)
      }

      const id = nextPending++
      pendingTabs.set(id, { adapter, spaceId, thread, name })
      const capabilities = adapters.get(adapter)
      yield* chat.call(adapter, "ask", {
        place: { kind: "thread", thread: ThreadId.make(thread) },
        text: "Who works here?",
        choices: Object.entries(agents).map(([name, agent]) => ({
          id: ActionId.make(`newtab:${id}:${name}`),
          label: name,
          emoji: agent.logo !== undefined && capabilities?.customEmoji
            ? { kind: "custom" as const, name: agent.logo }
            : { kind: "unicode" as const, value: agent.emoji }
        })) as never
      })
    })

  /**
   * Without rooms, a new thread names its space: `✳️api / fix-login` (the
   * agent emoji optional). Returns the space and the name left for the tab,
   * the emoji kept so the agent is still picked from it.
   */
  const spaceFromName = (name: string) => {
    const found = agentFromName(name)
    const rest = found === undefined ? name.trim() : found.rest
    const cut = rest.indexOf(" / ")
    if (cut < 0) return undefined
    const wanted = rest.slice(0, cut).trim().toLowerCase()
    const space = spaces.find((sp) => roomName(sp).toLowerCase() === wanted || sp.name.toLowerCase() === wanted)
    if (space === undefined) return undefined
    const tab = rest.slice(cut + 3).trim()
    return { space, name: found === undefined ? tab : `${agents[found.agent]!.emoji}${tab}` }
  }

  interface PendingSpace {
    readonly adapter: string
    readonly thread: string
    readonly name: string
  }
  const pendingSpaces = new Map<number, PendingSpace>()

  const threadCreated = (adapter: string, params: Params<AdapterToBridge["thread.created"]>) =>
    Effect.gen(function*() {
      const s = yield* loadStore
      const mine = s.state().adapters[adapter]
      if (mine === undefined) return
      if (Object.values(mine.threads).some((entry) => entry.thread === params.thread)) return // ours
      // The adapter's task first, then whatever is written before the tab starts.
      const collect = () =>
        firstMessages.set(threadKey(adapter, params.thread), params.task === undefined ? [] : [params.task])
      if (params.room !== undefined) {
        const spaceId = Object.entries(mine.rooms).find(([, room]) => room === params.room)?.[0]
        if (spaceId === undefined) return // not in one of our rooms: the owner's own channels
        collect()
        return yield* openTabFor(adapter, spaceId, params.thread, params.name, params.agent)
      }
      // A thread outside rooms means something only to an adapter without rooms.
      const capabilities = adapters.get(adapter)
      if (capabilities === undefined || capabilities.rooms) return
      collect()
      const named = spaceFromName(params.name)
      if (named !== undefined) {
        const tab = params.agent === undefined ? named.name : agentFromName(named.name)?.rest || named.name
        return yield* openTabFor(adapter, named.space.id, params.thread, tab, params.agent)
      }
      if (spaces.length === 0) return
      const id = nextPending++
      pendingSpaces.set(id, { adapter, thread: params.thread, name: params.name })
      yield* chat.call(adapter, "ask", {
        place: { kind: "thread", thread: ThreadId.make(params.thread) },
        text: "Which space?",
        choices: spaces.slice(0, capabilities.maxActions).map((space) => ({
          id: ActionId.make(`newtab:${id}@${space.id}`),
          label: roomName(space)
        })) as never
      })
    }).pipe(Effect.catch((error) => Effect.logWarning(`cannot open a tab for a new thread: ${error.message}`)))

  const answerNewTab = (adapter: string, params: Params<AdapterToBridge["action.pressed"]>) =>
    Effect.gen(function*() {
      const edit = (text?: string) =>
        chat.call(adapter, "message.edit", {
          place: params.place,
          message: params.message,
          actions: [],
          ...(text === undefined ? {} : { text })
        }).pipe(Effect.ignore)
      const where = /^newtab:(\d+)@(.+)$/.exec(params.action)
      if (where !== null) {
        const pending = pendingSpaces.get(Number(where[1]))
        const space = spaces.find((sp) => sp.id === where[2])
        if (pending === undefined || space === undefined) return yield* edit()
        pendingSpaces.delete(Number(where[1]))
        yield* edit(`Which space? → ${roomName(space)}`)
        return yield* openTabFor(pending.adapter, space.id, pending.thread, pending.name).pipe(
          Effect.catch((error) => Effect.logWarning(`cannot open a tab for a new thread: ${error.message}`))
        )
      }
      const match = /^newtab:(\d+):(.+)$/.exec(params.action)
      if (match === null) return
      const pending = pendingTabs.get(Number(match[1]))
      const agentName = match[2]!
      if (pending === undefined || agents[agentName] === undefined) return yield* edit()
      pendingTabs.delete(Number(match[1]))
      yield* edit(`Who works here? → ${agents[agentName]!.emoji} ${agentName}`)
      yield* startTab(pending.adapter, pending.spaceId, pending.thread, agentName, pending.name)
    })

  // Spaces made and closed from an adapter.

  /** An adapter's space.create: the space, its room and first thread linked before the layout change lands. */
  const createSpace = (adapter: string, params: Params<AdapterToBridge["space.create"]>) =>
    Effect.gen(function*() {
      const agent = params.agent === undefined ? undefined : agents[params.agent]
      if (params.agent !== undefined && agent === undefined) {
        return yield* new RpcError({
          code: ErrorCode.InvalidParams,
          message: `no agent named ${params.agent}; the agents are ${Object.keys(agents).join(", ")}`
        })
      }
      const folder = params.folder.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~")
      const tabName = params.tab ?? params.agent
      const task = agent === undefined ? undefined : params.task
      const created = yield* options.app.newSpace({
        name: params.name,
        folder,
        ...(tabName === undefined ? {} : { tab: tabName }),
        ...(agent === undefined ? {} : { argv: agentArgv(agent) }),
        ...(task === undefined || task === "" ? {} : { task })
      }).pipe(Effect.mapError((error) => new RpcError({ code: ErrorCode.InternalError, message: error.message })))

      const withRooms = adapters.get(adapter)?.rooms === true
      const space: Spaces.Space = { id: created.space, name: params.name, named: true, folder, tabs: [] }
      const room = withRooms ? (yield* chat.call(adapter, "room.ensure", { name: roomName(space) })).room : undefined
      const thread = created.tab === undefined || tabName === undefined
        ? undefined // a tab Herdr names itself: the sync makes its thread
        : (yield* chat.call(adapter, "thread.ensure", {
          ...(room === undefined ? {} : { room }),
          name: withRooms ? `${agent?.emoji ?? ""}${tabName}` : `${agent?.emoji ?? ""}${roomName(space)} / ${tabName}`,
          topic: `${roomName(space)} / ${tabName} — ${folder}`
        })).thread
      const s = yield* loadStore
      const state = s.state()
      const mine = state.adapters[adapter] ?? Store.emptyAdapter
      const threadEntry = thread === undefined
        ? undefined
        : agent === undefined
        ? { thread }
        : { thread, emoji: agent.emoji }
      yield* s.save({
        adapters: {
          ...state.adapters,
          [adapter]: {
            ...mine,
            rooms: room === undefined ? mine.rooms : { ...mine.rooms, [created.space]: room },
            threads: threadEntry === undefined || created.tab === undefined
              ? mine.threads
              : { ...mine.threads, [created.tab]: threadEntry }
          }
        }
      })
      yield* Effect.logInfo(`${adapter}: made space ${params.name} in ${folder}`)
      const result: Result<AdapterToBridge["space.create"]> = {
        ...(room === undefined ? {} : { room }),
        ...(thread === undefined ? {} : { thread })
      }
      return result
    }).pipe(
      Effect.mapError((error) =>
        error instanceof RpcError ? error : new RpcError({ code: ErrorCode.InternalError, message: error.message })
      )
    )

  /** The owner deleted a room: its space is closed in herdr, and the sync archives its threads. */
  const roomDeleted = (adapter: string, room: string) =>
    Effect.gen(function*() {
      const s = yield* loadStore
      const mine = s.state().adapters[adapter]
      const spaceId = Object.entries(mine?.rooms ?? {}).find(([, id]) => id === room)?.[0]
      if (spaceId === undefined) return // the archive, or a room not ours
      const space = spaces.find((sp) => sp.id === spaceId)
      yield* Effect.logInfo(`${adapter}: room of space ${space?.name ?? spaceId} deleted; closing the space`)
      // On failure the space stays, and the next sync makes its room again.
      yield* options.app.closeSpace(spaceId).pipe(
        Effect.catch((error) => Effect.logWarning(`cannot close space ${spaceId} in herdr-app: ${error.message}`))
      )
    }).pipe(Effect.catch((error) => Effect.logWarning(`cannot handle a deleted room: ${error.message}`)))

  // Agents' states as data, for adapters that ask for them (capabilities.status).

  const notifyStatus = (address: string, state: string, status?: Terminal["status"], only?: string) =>
    Effect.gen(function*() {
      const tab = tabOf(address)
      if (tab === undefined) return
      const s = yield* loadStore
      for (const [adapter, capabilities] of adapters) {
        if (capabilities.status !== true || (only !== undefined && adapter !== only)) continue
        const entry = s.state().adapters[adapter]?.threads[tab.id]
        if (entry === undefined) continue
        yield* chat.notify(adapter, "thread.status", {
          thread: ThreadId.make(entry.thread),
          terminal: address,
          state,
          ...(status?.kind == null ? {} : { kind: status.kind }),
          ...(status?.msg === undefined || status.msg === "" ? {} : { text: status.msg })
        })
      }
    }).pipe(Effect.catch((error) => Effect.logWarning(`cannot send a status: ${error.message}`)))

  /** Every agent's current state, to an adapter that just connected. */
  const notifyAllStatuses = (adapter: string) =>
    Effect.suspend(() =>
      adapters.get(adapter)?.status !== true
        ? Effect.void
        : Effect.forEach(
          [...terminals.values()].filter((t) => t.state === "live" && t.status != null),
          (t) => notifyStatus(t.address, t.status!.state, t.status, adapter),
          { discard: true }
        )
    )

  // Commands.

  const screenText = (text: string, max: number) => {
    const lines = text.split("\n").map((line) => line.trimEnd())
    while (lines.length > 0 && lines.at(-1) === "") lines.pop()
    const kept: Array<string> = []
    let size = 8 // the code fence
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.replaceAll("```", "ˋˋˋ")
      if (size + line.length + 1 > max) break
      kept.unshift(line)
      size += line.length + 1
    }
    return "```\n" + kept.join("\n") + "\n```"
  }

  const statusLines = () => {
    const lines: Array<string> = []
    for (const space of spaces) {
      lines.push(`**${roomName(space)}**`)
      for (const tab of space.tabs) {
        const states = tab.terminals.map((address) => {
          const terminal = terminals.get(address)
          const agent = terminal === undefined ? undefined : agentOf(agents, terminal)
          const emoji = agent === undefined ? "▫️" : agents[agent]!.emoji
          const state = terminal?.status?.state ?? terminal?.state ?? "gone"
          const msg = terminal?.status?.msg === undefined || terminal.status.msg === ""
            ? ""
            : `: ${truncate(terminal.status.msg, 60)}`
          return `${emoji} ${stateIcon[state] ?? ""}${stateIcon[state] ? " " : ""}${state}${msg}`
        })
        lines.push(`  ${tab.name} — ${states.join(", ") || "empty"}`)
      }
    }
    return lines.length === 0 ? "No herdr spaces." : lines.join("\n")
  }

  // The dashboard: one message in the direct conversation, edited (no pushes) as agents change.

  let dashboardDirty = true
  const markDirty = Effect.sync(() => (dashboardDirty = true))

  const updateDashboards = Effect.gen(function*() {
    if (!dashboardDirty) return
    dashboardDirty = false
    const s = yield* loadStore
    const time = new Date(yield* Clock.currentTimeMillis).toTimeString().slice(0, 5)
    for (const [adapter, capabilities] of adapters) {
      if (!capabilities.direct || !capabilities.edit) continue
      const place: Place = { kind: "direct" }
      const known = s.state().adapters[adapter]?.dashboard
      if (options.withoutDashboard?.includes(adapter)) {
        // Turned off: the last one says so once, then it is forgotten.
        if (known === undefined) continue
        yield* chat.call(adapter, "message.edit", {
          place,
          message: MessageId.make(known),
          text: "The live status is off here; `/status` shows it."
        }).pipe(Effect.ignore)
        const state = s.state()
        const { dashboard: _, ...mine } = state.adapters[adapter] ?? Store.emptyAdapter
        yield* s.save({ adapters: { ...state.adapters, [adapter]: mine } })
        continue
      }
      const text = truncate(`${statusLines()}\n\n_updated ${time}_`, capabilities.maxText)
      const edited = known === undefined
        ? false
        : yield* chat.call(adapter, "message.edit", { place, message: MessageId.make(known), text }).pipe(
          Effect.as(true),
          // Deleted by the owner: post a new one. Any other failure: try again next time.
          Effect.catch((error) => Effect.succeed(error._tag === "RpcError" && error.code === ErrorCode.NotFound ? false : "later" as const))
        )
      if (edited === "later") {
        dashboardDirty = true
        continue
      }
      if (edited) continue
      const posted = yield* chat.call(adapter, "message.post", { place, text })
      const state = s.state()
      const mine = state.adapters[adapter] ?? Store.emptyAdapter
      yield* s.save({ adapters: { ...state.adapters, [adapter]: { ...mine, dashboard: posted.message } } })
    }
  }).pipe(Effect.catch((error) => Effect.logWarning(`cannot update the dashboard: ${error.message}`)))

  // Quick tasks from the direct conversation: pick a space, a new tab starts on it.

  interface PendingTask {
    readonly agent: string
    readonly task: string
    readonly question: string
  }
  const pendingTasks = new Map<number, PendingTask>()
  let nextTask = 1
  const defaultAgent = Object.keys(agents)[0]

  const askWhere = (adapter: string, params: Params<AdapterToBridge["message.received"]>, text: string) =>
    Effect.gen(function*() {
      const found = agentFromName(text)
      const agent = found?.agent ?? defaultAgent
      const task = (found === undefined ? text : found.rest).trim()
      if (agent === undefined) return "No agents in the config."
      if (task === "") return helpText
      if (spaces.length === 0) return "No herdr spaces to run it in: make one with `/space new`."
      const id = nextTask++
      const question = `${agents[agent]!.emoji} ${agent}, where?`
      pendingTasks.set(id, { agent, task, question })
      const max = adapters.get(adapter)?.maxActions ?? 25
      yield* chat.call(adapter, "ask", {
        place: params.place,
        text: question,
        choices: spaces.slice(0, max).map((space) => ({ id: ActionId.make(`task:${id}:${space.id}`), label: roomName(space) })) as never
      })
      return undefined
    })

  const answerTask = (adapter: string, params: Params<AdapterToBridge["action.pressed"]>) =>
    Effect.gen(function*() {
      const match = /^task:(\d+):(.+)$/.exec(params.action)
      if (match === null) return
      const pending = pendingTasks.get(Number(match[1]))
      const space = spaces.find((sp) => sp.id === match[2])
      const edit = (text?: string) =>
        chat.call(adapter, "message.edit", {
          place: params.place,
          message: params.message,
          actions: [],
          ...(text === undefined ? {} : { text })
        }).pipe(Effect.ignore)
      if (pending === undefined || space === undefined) return yield* edit()
      pendingTasks.delete(Number(match[1]))
      const agent = agents[pending.agent]!
      const name = slug(pending.task)
      const started = yield* options.app.newTab({
        space: space.id,
        name,
        folder: space.folder,
        argv: agentArgv(agent),
        task: pending.task
      }).pipe(Effect.result)
      yield* edit(
        started._tag === "Failure"
          ? `${pending.question}\n→ ⚠️ ${started.failure.message}`
          : `${pending.question}\n→ started in ${roomName(space)} / ${name}; follow it in its channel.`
      )
    })

  const runCommand = (adapter: string, params: Params<AdapterToBridge["command.invoked"]>) =>
    Effect.gen(function*() {
      const max = adapters.get(adapter)?.maxText ?? 2000
      switch (params.command) {
        case "screen": {
          if (params.place.kind !== "thread") return "Use /screen in a tab's channel."
          const s = yield* loadStore
          const tab = tabOfThread(s, adapter, params.place.thread)
          const terminal = tab === undefined ? undefined : terminalOfTab(tab)
          if (terminal === undefined) return "No herdr terminal behind this channel."
          const screen = yield* core.call("terminal.read", { terminal }).pipe(Effect.option)
          return screen._tag === "None" ? "Cannot read the screen." : screenText(screen.value.text, max)
        }
        case "status":
          return truncate(statusLines(), max)
        case "space new": {
          const name = String(params.args.name ?? "").trim()
          const folder = String(params.args.folder ?? "").trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~")
          const agentName = typeof params.args.agent === "string" ? params.args.agent : undefined
          const agent = agentName === undefined ? undefined : agents[agentName]
          const task = typeof params.args.task === "string" && params.args.task !== "" ? params.args.task : undefined
          if (name === "" || folder === "") return "Give a name and a folder."
          const result = yield* options.app.newSpace({
            name,
            folder,
            ...(agent === undefined ? {} : { tab: agentName!, argv: agentArgv(agent) }),
            ...(task === undefined ? {} : { task })
          }).pipe(Effect.result)
          return result._tag === "Failure"
            ? `⚠️ ${result.failure.message}`
            : `Space **${name}** is being made in ${folder}; its category appears in a moment.`
        }
        default:
          return `Unknown command ${params.command}.`
      }
    }).pipe(Effect.catch((error) => Effect.succeed(`⚠️ ${error.message}`)))

  // Progress: while an agent works on a long turn, one status message in its
  // thread says so, edited in place (edits don't push) with the time spent and
  // the agent's latest notes; at the end it shrinks to one line.

  interface Progress {
    readonly started: number
    notes: ReadonlyArray<string>
    waiting: boolean
    posted: ReadonlyArray<Posted>
    shown: string
  }
  const progress = new Map<string, Progress>()

  const elapsed = (ms: number) => {
    const total = Math.max(1, Math.floor(ms / 60_000))
    return total < 60 ? `${total} min` : `${Math.floor(total / 60)} h ${total % 60} min`
  }

  /** The first line of a note, short. */
  const noteOf = (text: string) => {
    const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? ""
    return line.length > maxNote ? `${line.slice(0, maxNote - 1)}…` : line
  }

  const startProgress = (address: string) =>
    Effect.gen(function*() {
      const known = progress.get(address)
      if (known !== undefined) {
        known.waiting = false
        return known
      }
      const started: Progress = { started: yield* Clock.currentTimeMillis, notes: [], waiting: false, posted: [], shown: "" }
      progress.set(address, started)
      return started
    })

  const addNote = (address: string, text: string) =>
    Effect.gen(function*() {
      const note = noteOf(text)
      if (note === "") return
      const entry = yield* startProgress(address)
      if (entry.notes.at(-1) !== note) entry.notes = [...entry.notes, note].slice(-keptNotes)
    })

  const progressText = (address: string, entry: Progress, now: number) =>
    [
      speaker(address, `${entry.waiting ? "⏸ waiting for you" : "⏳ working"} · ${elapsed(now - entry.started)}`),
      ...entry.notes.map((note) => `› ${note}`)
    ].join("\n")

  const editPosted = (posted: ReadonlyArray<Posted>, text: string) =>
    Effect.forEach(
      posted,
      (post) => chat.call(post.adapter, "message.edit", { place: post.place, message: post.message, text }).pipe(Effect.ignore),
      { discard: true }
    )

  const updateProgress = Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    for (const [address, entry] of progress) {
      if (entry.posted.length === 0 && now - entry.started < showProgressAfter) continue
      const text = progressText(address, entry, now)
      if (text === entry.shown) continue
      entry.shown = text
      if (entry.posted.length === 0) entry.posted = yield* postToTab(address, text)
      else yield* editPosted(entry.posted, text)
    }
  })

  const finishProgress = (address: string, state: string) =>
    Effect.gen(function*() {
      const entry = progress.get(address)
      if (entry === undefined) return
      progress.delete(address)
      if (entry.posted.length === 0) return
      const took = elapsed((yield* Clock.currentTimeMillis) - entry.started)
      yield* editPosted(entry.posted, speaker(address, state === "done" ? `✅ worked ${took}` : `⏹ stopped after ${took}`))
    })

  const onHook = (message: HookMessage) => {
    switch (message.event) {
      case "Stop":
        if (message.text === undefined || message.text.trim() === "") return Effect.void
        lastReply.set(message.terminal, Date.now())
        return postToTab(message.terminal, speaker(message.terminal, message.text))
      case "StopFailure":
        lastReply.set(message.terminal, Date.now())
        return postToTab(
          message.terminal,
          speaker(message.terminal, `❌ The turn failed: ${message.error ?? message.text ?? "unknown error"}`)
        )
      case "Notification":
        return Effect.void // permission prompts: next step
      case "PreToolUse":
        return Effect.gen(function*() {
          if (message.text !== undefined) yield* addNote(message.terminal, message.text)
          if (message.questions === undefined) return
          asked.set(message.terminal, message.questions)
          // The status may have said "question" before the hook's copy arrived.
          if (isQuestionOnScreen(message.terminal)) yield* openForm(message.terminal)
        })
    }
  }

  const onCore = (event: CoreEvent) => {
    switch (event._tag) {
      case "snapshot":
        return Effect.gen(function*() {
          terminals.clear()
          for (const terminal of event.terminals) terminals.set(terminal.address, terminal)
          yield* loadSpaces
          yield* syncAll
          for (const prompt of [...prompts.values()]) {
            if (terminals.get(prompt.address)?.status?.state !== "blocked") {
              yield* closePrompt(prompt, "answered in herdr")
            }
          }
          for (const address of [...progress.keys()]) {
            const state = terminals.get(address)?.status?.state
            if (state !== "working" && state !== "blocked") yield* finishProgress(address, state ?? "gone")
          }
          for (const terminal of event.terminals) {
            if (terminal.status?.state === "working") yield* startProgress(terminal.address)
            if (terminal.status?.state === "blocked" && terminal.status.kind === "permission") {
              yield* openPrompt(terminal.address, terminal.status)
            }
          }
        })
      case "doc":
        return event.name === Spaces.docName ? loadSpaces.pipe(Effect.andThen(syncAll)) : Effect.void
      case "created":
        return Effect.sync(() => terminals.set(event.terminal.address, event.terminal))
      case "status":
        return Effect.gen(function*() {
          const terminal = terminals.get(event.address)
          const before = terminal?.status?.state
          if (terminal !== undefined) {
            terminals.set(event.address, { ...terminal, ...(event.status === null ? {} : { status: event.status }) })
          }
          const state = event.status?.state
          const open = prompts.get(event.address)
          if (open !== undefined && state !== "blocked") yield* closePrompt(open, "answered in herdr")
          const form = forms.get(event.address)
          if (form !== undefined && state !== "blocked") yield* closeForm(form, "answered in herdr")
          if (state === "done" || state === "idle") asked.delete(event.address)
          if (state === "working") yield* startProgress(event.address)
          else if (state === "blocked") {
            const entry = progress.get(event.address)
            if (entry !== undefined) entry.waiting = true
          } else if (state !== undefined) yield* finishProgress(event.address, state)
          if (state === undefined || state === before) return
          yield* notifyStatus(event.address, state, event.status)
          if (state === "blocked" && event.status?.kind === "permission") {
            return yield* openPrompt(event.address, event.status)
          }
          if (state === "blocked" && event.status?.kind === "question") {
            if (asked.has(event.address)) return yield* openForm(event.address)
            // Wait a moment for the hook's copy of the form.
            return yield* Effect.sleep(questionGrace).pipe(
              Effect.andThen(Queue.offer(later, { from: "question", address: event.address })),
              Effect.forkScoped
            )
          }
          const status = statusText(state, event.status)
          if (status === undefined) return
          const text = speaker(event.address, status)
          if (state !== "done") return yield* postToTab(event.address, text)
          // The hook's reply says more than "Done"; post the bare status only without one.
          const doneAt = Date.now()
          yield* Effect.sleep(replyGrace).pipe(
            Effect.andThen(Effect.suspend(() =>
              (lastReply.get(event.address) ?? 0) >= doneAt - 30_000 ? Effect.void : postToTab(event.address, text)
            )),
            Effect.forkScoped
          )
        })
      case "labels":
        return Effect.suspend(() => {
          const terminal = terminals.get(event.address)
          if (terminal === undefined) return Effect.void
          const space = spaces.find((sp) => sp.tabs.some((tab) => tab.terminals.includes(event.address)))
          const before = space === undefined ? undefined : roomName(space)
          terminals.set(event.address, { ...terminal, labels: event.labels })
          // An unnamed space follows its terminal's folder: rename its room.
          return space !== undefined && roomName(space) !== before ? syncAll : Effect.void
        })
      case "title":
      case "foreground":
        return Effect.sync(() => {
          const terminal = terminals.get(event.address)
          if (terminal === undefined) return
          if (event._tag === "title") terminals.set(event.address, { ...terminal, title: event.title })
          if (event._tag === "foreground") {
            terminals.set(event.address, { ...terminal, foreground: event.foreground })
          }
        })
      case "removed":
        return Effect.gen(function*() {
          if (terminals.get(event.address)?.state === "live") yield* notifyStatus(event.address, "gone")
          terminals.delete(event.address)
          yield* finishProgress(event.address, "gone")
          const open = prompts.get(event.address)
          if (open !== undefined) yield* closePrompt(open, "the terminal is gone")
          const form = forms.get(event.address)
          if (form !== undefined) yield* closeForm(form, "the terminal is gone")
          asked.delete(event.address)
        })
      default:
        return Effect.void
    }
  }

  const onChat = (event: ChatEvent) => {
    switch (event._tag) {
      case "adapter.connected":
        return Effect.sync(() => adapters.set(event.adapter, event.capabilities)).pipe(
          Effect.andThen(syncAdapter(event.adapter)),
          Effect.andThen(notifyAllStatuses(event.adapter)),
          Effect.andThen(markDirty)
        )
      case "adapter.disconnected":
        return Effect.sync(() => adapters.delete(event.adapter))
      case "command.invoked":
        return runCommand(event.adapter, event.params).pipe(
          Effect.flatMap((text) => Deferred.succeed(event.reply, { text }))
        )
      case "space.create":
        return createSpace(event.adapter, event.params).pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(event.reply, exit))
        )
      case "room.deleted":
        return roomDeleted(event.adapter, event.params.room)
      case "thread.created":
        return threadCreated(event.adapter, event.params)
      case "message.received":
        return forward(event.adapter, event.params)
      case "action.pressed":
        return event.params.action.startsWith("newtab:")
          ? answerNewTab(event.adapter, event.params)
          : event.params.action.startsWith("task:")
          ? answerTask(event.adapter, event.params)
          : event.params.action.startsWith("send:")
          ? answerSend(event.adapter, event.params)
          : event.params.action.startsWith("q:")
          ? answerQuestion(event.adapter, event.params)
          : answerPrompt(event.adapter, event.params)
      case "thread.deleted":
        return threadDeleted(event.adapter, event.params.thread)
      default:
        return Effect.logDebug(`${event.adapter}: ${event._tag} (not handled yet)`)
    }
  }

  type Input =
    | { readonly from: "core"; readonly event: CoreEvent }
    | { readonly from: "chat"; readonly event: ChatEvent }
    | { readonly from: "hook"; readonly event: HookMessage }
    | { readonly from: "tick" }
    | { readonly from: "dashboard" }
    | { readonly from: "progress" }
    | { readonly from: "question"; readonly address: string }
    | {
      readonly from: "start"
      readonly adapter: string
      readonly spaceId: string
      readonly thread: string
      readonly agent: string
      readonly name: string
    }
  const dashboardTicks = options.dashboardEvery === undefined
    ? Stream.empty
    : Stream.tick(options.dashboardEvery).pipe(Stream.map((): Input => ({ from: "dashboard" })))
  const progressTicks = options.progressEvery === undefined
    ? Stream.empty
    : Stream.tick(options.progressEvery).pipe(Stream.map((): Input => ({ from: "progress" })))
  yield* Stream.mergeAll([
    core.events.pipe(Stream.map((event): Input => ({ from: "core", event }))),
    chat.events.pipe(Stream.map((event): Input => ({ from: "chat", event }))),
    options.hooks.pipe(Stream.map((event): Input => ({ from: "hook", event }))),
    Stream.tick(sweepEvery).pipe(Stream.drop(1), Stream.map((): Input => ({ from: "tick" }))),
    dashboardTicks,
    progressTicks,
    Stream.fromQueue(later)
  ], { concurrency: "unbounded" }).pipe(
    Stream.runForEach((input) => {
      switch (input.from) {
        case "dashboard":
          return updateDashboards
        case "progress":
          return updateProgress
        case "question":
          return isQuestionOnScreen(input.address)
            ? questionShown(input.address, terminals.get(input.address)?.status)
            : Effect.void
        case "start":
          return startTab(input.adapter, input.spaceId, input.thread, input.agent, input.name).pipe(
            Effect.catch((error) => Effect.logWarning(`cannot open a tab for a new thread: ${error.message}`))
          )
        case "core":
          return onCore(input.event).pipe(Effect.andThen(input.event._tag === "other" ? Effect.void : markDirty))
        case "chat":
          return onChat(input.event)
        case "hook":
          return onHook(input.event)
        case "tick":
          return sweepAll
      }
    })
  )
})
