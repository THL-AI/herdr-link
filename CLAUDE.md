# herdr-link

Control the coding agents running in herdr from a messenger. Discord already gives us a server, a phone app, push notifications,
history, buttons and slash commands, so instead of building a mobile client we
link herdr-core to chat apps through adapters.

Personal notes for the maintainer's own machine live in `CLAUDE.local.md`
(git-ignored). Code, comments, commits and docs are in English.

## Commands

```
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest
pnpm schema           # regenerate schema/chat.openrpc.json (a test checks it)
pnpm start            # the bridge in the foreground (= herdr-link run)
```

The `herdr-link` CLI (`src/cli/`): `init` (setup wizard: token, intent, owner
and guild found through the Discord API, agents on PATH, config + `.env`,
hooks, service; Discord only), `telegram` (reads the bot's recent updates:
groups with topics/admin checks and user ids, prints the config section),
`status [--json]` (reads `status.json`), `desk on | off`, `adapter <name>
on | off` / `adapter <name> dashboard on | off` (one line of the TOML, then a
service restart), `mod install | uninstall` (the herdr-app bar),
`doctor [--fix] [--yes]` (every check knows its fix: hooks,
service, Message Content intent, `hc server start`, `init`; installing herdr
through its official script `curl -fsSL https://releases.herdr.dev/core/install.sh | sh`
(app: `.../app/install.sh`) only after asking), `run`, `service install | uninstall | status |
logs | restart` (launchd on macOS, a systemd user unit on Linux, both through the
user's login shell with this Node), `hooks install | uninstall`. In a checkout
the pnpm scripts `hooks:install`, `service:install`… call it.

`CHANGELOG.md` (Keep a Changelog): every user-facing change goes under
`## Unreleased` as it lands; a release renames that to `## <version>
(date)`, and the release workflow refuses a tag without its section and uses
it as the GitHub release notes. It is also a page of the site.

Published to npm as `@thl-ai/herdr-link` (`herdr-link` is taken by an
unrelated package) by `.github/workflows/release.yml` on a `v*` tag matching
`package.json`, through npm trusted publishing (OIDC from GitHub Actions; no
npm token, provenance included). The package ships JavaScript compiled
into `dist/` (`pnpm build`, `tsconfig.build.json`, run by `prepack`; imports
rewritten from `.ts`), not the sources: no tsx or esbuild for users (npm 11
warns about esbuild's install script). `files` in `package.json` lists what
goes in. CI runs on Ubuntu and macOS, and installs the packed tarball once.

## Architecture

```
 adapter processes (any language)     Discord   Telegram   ...
        ⇅ JSON-RPC over stdin/stdout (the Chat protocol)
 bridge core: Space ↔ Room, Tab ↔ Thread, routing, prompts, archive
        ⇅ JSON-RPC over the hc unix socket          ⇅ herdr-app CLI
 herdr-core (terminals, statuses, send/keys/read/put, events, docs)
        ⇡ one JSON line per agent turn
 shared agent hook (Claude Code / Grok `Stop`, `StopFailure`, `Notification`, `PreToolUse`)
```

Rule: the bridge core never says "Discord", "channel" or "category". It speaks
Room / Thread / Place / Action / capabilities; platform specifics stay in
adapters. Each port is an Effect `Context.Service`; tests use fakes.

- `src/protocol/`: the Chat protocol. `Chat.ts` (types), `Methods.ts` (method
  tables), `JsonRpc.ts` (envelope, error codes), `Rpc.ts` (method defs),
  `Peer.ts` (bidirectional JSON-RPC over a line `Transport`: notifications in
  order, requests concurrently, a handler may call back), transports for
  stdio, unix sockets and in-memory pairs, `OpenRpc.ts` (the export).
- `src/chat/`: the `Chat` port. `Adapters.ts` spawns one process per
  `[adapters.*]` section (`AdapterProcess.ts`: `hello`, stderr to the log,
  restart with backoff, not after InvalidConfig / UnsupportedProtocol; only
  the env vars listed in `env` plus PATH, HOME, LANG…; built-in adapters are
  resolved by bin name).
- `src/core/`: the `HerdrCore` port (`call` over `Methods.ts` on one shared
  connection reopened after a core restart; `events`: a snapshot, then decoded
  events, a fresh snapshot after a reconnect or `missed`), `Spaces.ts` (the
  `herdr-app` document), `HerdrApp.ts` (`herdr-app do tab.new / tab.close /
  space.new`).
- `src/bridge/`: `Bridge.ts` (the router, one loop over core events, chat
  events, hook messages and timers, so its state needs no locks), `Store.ts`
  (id mapping in the core doc `herdr-link`), `Hooks.ts` (the hook socket),
  `Commands.ts`, `Text.ts` (splitting at `maxText`, code fences balanced).
- `src/adapters/discord/main.ts`: the Discord adapter, its own process.
- `src/adapters/telegram/`: the Telegram adapter (`main.ts`: Bot API through
  `fetch` and long polling, no SDK; `Text.ts`: Markdown → Telegram HTML,
  command arguments parsed from text, the `/` menu).
- `src/cli/`: the `herdr-link` command (`main.ts` dispatches; `init`,
  `doctor`, `service`, `hooks`, Discord REST for setup, local probes).
- `docs/`: user docs (configuration, agents, writing an adapter,
  troubleshooting). `docs/install-with-an-agent.md` is written for a coding
  agent installing herdr-link; the site also serves it raw as `/install.md`
  (the link people give their agent), so it uses absolute links and must
  match what the CLI really asks. Keep them true to the code; the README stays chat-agnostic
  (Discord is the built-in adapter, not the product).
- `src/bridge/LocalState.ts`: `~/.local/state/herdr-link/state.json` (the
  desk switch, written by the CLI and the mod, read on every post) and
  `status.json` (written by `main.ts` on a change, at least every 30 s).
- `mod/herdr-link/`: the herdr-app mod (gpui-kit JS, not TypeScript; types in
  `~/.config/herdr-app/*.d.ts`). A kept `window` overlay (shipped layouts
  refuse new blocks), opened by `mod install` with `herdr-app do mod.open`;
  `link.js` (node, bin, state paths) is written at install. Check it with
  `herdr-app check <folder>`; a click target must stop mouse-down
  propagation or the press drags the window.
- `hooks/herdr-link-hook.mjs`: the shared agent hook (plain Node, fast). `bin/`:
  entry points runnable from anywhere (`bin/load.mjs`: `src/` through tsx in
  a checkout, `dist/` in the package; `herdr-link` loads
  `~/.config/herdr-link/.env`, or a `.env` in a checkout).

## Behaviour

- **herdr is the source of truth.** A herdr space → a private room (Discord:
  a category only the owner and the bot see), each tab → a thread named
  `<agent emoji><tab>`. Names as herdr-app shows them: an unnamed space is
  called after where its first terminal is now (the terminal's `where`
  label, "ram / main"; a `labels` event that changes it resyncs), an unnamed
  tab by its place (1, 2…). Rooms and threads made by hand are never touched. An
  adapter without `rooms` gets top-level threads named `<space> / <tab>`, and
  a closed tab's thread is deleted (no archive).
- **Owner → agent:** a message in a tab's thread → `terminal.send` to the tab's
  agent terminal (attachments via `terminal.put` first), then 👀. `blocked` /
  `finished` errors are answered in the thread.
- **Split tabs** (several panes in one tab) share the tab's thread. With more
  than one live pane, the bridge signs each pane's messages ("✳️ claude ·
  …", numbered when two look alike) and routes the owner's message: a reply →
  the pane that posted the replied-to message (remembered in memory, last
  2000), a leading agent emoji → that agent's pane (emoji stripped), only one
  pane → it, else an `ask` "Who is this for?" with the panes.
- **Machines:** a space on another herdr machine (`hc machine add`; the space's
  `machine` in the `herdr-app` doc) has its room named `api · build-box`. With
  herdr-link on several computers, each runs its own bot (two bridges on one
  bot would both answer the DM and commands; a bot cannot see another bot's
  private categories, so this is not detected) and sets `machine` in its
  config: its rooms and its archive get that suffix. Room names with the
  machine are also used in the dashboard, topics and quick-task choices.
- **Agent → owner:** the hook's `Stop` reply goes to the thread. `done` without
  a hook reply within 4 s → "✅ Done"; `blocked` → "⚠️ Needs you".
- **Progress:** a turn still `working` after 45 s gets one status message in
  its thread ("⏳ working · 6 min" and the agent's last 3 notes: the first line
  of its text between actions, which the hook reads from the transcript's end
  on `PreToolUse`). It is edited, never reposted (edits don't push), at most
  every 15 s and only on a change; `blocked` shows "⏸ waiting for you"; at
  the end it shrinks to "✅ worked 12 min" / "⏹ stopped after 3 min". Quick
  turns get none. In memory: after a restart a working agent starts a new one.
- **Permission prompts** (`blocked` + kind `permission`) → Allow / Allow
  always / Deny buttons for the keys the agent has in config, sent with
  `terminal.keys`; the message is edited to the outcome, or to "answered in
  herdr". A "trust this folder?" question gets only a Trust button (`trust`
  keys). One open prompt per terminal, in memory; after a restart the snapshot
  reopens prompts still blocked and stale buttons are cleared.
- **Question forms** (Claude Code's AskUserQuestion): the hook's `PreToolUse`
  brings the questions, `blocked` + kind `question` says the form is on
  screen (up to 1.5 s apart, either order; without the hook's copy the plain
  "⚠️ Needs you" goes out). One message per question, options as buttons:
  single select → its digit (moves on; the only question submits), multi
  select → digits toggle, Next/Submit → `tab`; a form of several questions or
  a multi select ends on a review screen → `1`. A message in the thread is the
  owner's own answer: single select → the "Type something" digit, then
  `terminal.send` with `force`; multi select can't take typed text (digits go
  into it), so `esc` closes the form and the text is sent as a message. Keys
  that change the screen are 400 ms apart, in a fork. In memory only.
- **New threads:** a thread the owner creates in one of the bot's space rooms
  → a new tab there (`herdr-app do tab.new`). A leading agent emoji (`✳️api`,
  compared without U+FE0F) picks the agent; otherwise "Who works here?" with
  buttons and logo reactions. Without rooms, the name says the space
  (`✳️api / fix`), else "Which space?" first. The tab starts 2 s after the
  thread appears (scheduled through the loop's own input queue), and messages
  written in the thread until then (or while a question is open) become its
  agent's first task (`task` of `tab.new`): Telegram creates a topic only
  together with its first message. The thread is linked before the layout
  change lands, so the sync renames it instead of making another.
- **Closed in herdr:** a tab's thread moves to `📦 archive` and is deleted
  after 7 days (hourly sweep, at most 45 kept); a closed space's room is
  deleted. An empty layout archives nothing (likely the app restarting).
- **Deleted by the owner:** the tab is closed in herdr (`tab.close`, else
  `terminal.kill`). The bot's own creations and deletions are never reported
  back by the adapter.
- **Commands:** `/screen` (the tab's screen), `/status`, `/space new name
  folder agent? task?`.
- **DM = control room:** a dashboard message edited at most every 10 s (edits
  don't push; reposted only when the edit says NotFound; `dashboard = false`
  in an adapter's section turns it off, editing the last one to say so once)
  and quick tasks: a DM text → "where?" with the spaces → a new tab whose
  agent gets the text as its first message.
- **At the desk / away:** while `state.json` says `desk`, every
  `message.post` and `ask` carries `silent: true` (Discord
  SuppressNotifications, Telegram `disable_notification`); edits never push
  anyway. Switched from the Herdr bar or `herdr-link desk`.
- Later idea: give a client read-only access to one project channel.

## Chat protocol (v1)

JSON-RPC 2.0, one message per line, both sides send requests and
notifications; stderr is the adapter's log. Exported for adapter authors as
`schema/chat.openrpc.json`.

- Bridge → adapter: `hello` (first: protocol version, the adapter's config
  section, the commands to register; the adapter validates its config,
  connects and answers with name, version, capabilities), `room.ensure`,
  `room.delete`, `thread.ensure` (create, or reuse by id: move, rename),
  `thread.delete`, `message.post` (text, files, actions), `message.edit`,
  `react`, `ask` (returns at once; the answer comes as `action.pressed`,
  button or reaction).
- Adapter → bridge: `thread.created` (`agent?`, `task?`: a program starts a
  tab at once), `thread.deleted`, `room.deleted` (closes the space),
  `message.received`, `reaction.added`, `action.pressed` (notifications),
  `command.invoked` (request; the result is the reply), `space.create`
  (request: the space, its room and first thread linked before the layout
  change lands, like `startTab`).
- Bridge → adapter notification `thread.status` (`thread`, `terminal`,
  `state`, `kind?`, `text?`), only with `capabilities.status`: on every state
  change, `gone` when a live terminal is removed, and every agent's state
  right after `hello`.
- Not every adapter is a chat app: a program with its own interface (a
  pipeline, a board) is an adapter that drives agents through the same
  protocol.
- A message lives in a `Place`: a thread, or `direct` (the owner's DM). Ids are
  opaque strings the bridge stores and never parses. The bridge splits text at
  `capabilities.maxText`. The adapter authenticates its senders (owner check);
  the bridge trusts only the adapters in its config.

## Config

`~/.config/herdr-link/config.toml` (or `$HERDR_LINK_CONFIG`, or `herdr-link
run <path>`), written by `herdr-link init`, decoded with Effect Schema,
unknown keys rejected. Secrets live in `~/.config/herdr-link/.env` (0600) or a
checkout's `.env`, never in the TOML. See
`config.example.toml`. Bridge keys of an adapter section: `command`, `env`,
`enabled` (false: not started), `dashboard` (false: no DM dashboard); the
rest goes to the adapter in `hello`. Agent keys verified live:

- Claude Code 2.1.316: `1` Yes, `2` Yes and don't ask again, `3` auto mode,
  `4` No, `esc` cancels (= No; status goes `idle`, not `done`). A new folder
  first shows a trust dialog without a herdr status.
- Claude Code 2.1.317 AskUserQuestion: a tab bar (questions, Submit) when
  there are several; `1`..`n` pick (single select, moves on) or toggle (multi
  select, cursor stays), `n+1` "Type something" (single: cursor there, typed
  text + Enter answers), then "Chat about this" (declines the form); `tab`
  next; review screen `1` Submit answers, `2` Cancel; `esc` cancels.
  `terminal.send` refuses a blocked terminal unless `force`.
- Grok Build: `1` always-approve everything (never send), `2` always allow this
  command, `3` Yes, `4` No (goes `idle`), `5` never allow; digits act at once.
  Safe commands run without asking. A new folder asks "trust this folder?"
  (`y` / `n`, reported as `permission`). Signed out: `auth` / "Sign in to Grok".

## Security

- Every inbound message, reaction, button and command is checked against the
  owner's user id in the adapter: channel access means code execution.
- Nobody else on the server should have Administrator / Manage Channels /
  Manage Roles. Restrict the slash commands in Server Settings → Integrations.
- The hook socket is `0600` in a `0700` directory; one bridge per user (it
  exits if the socket already answers).
- Don't send secrets through the bridge; the chat platform sees everything.

## herdr-core facts

- JSON-RPC 2.0, one message per line; unix socket
  `~/.local/state/herdr-core/default/default.sock` (also `$HC_TERMINAL_SOCKET`
  inside herdr terminals). Full schema: `hc schema`. Handshake `hello` with
  `generation: 1`.
- After `events.subscribe` a plain connection carries **only** notifications,
  so subscriptions use their own connection. Notifications: `event`
  `{seq, type, terminal?, data}`, `heartbeat` `{seq}` every 15 s, `missed`.
  Event `data` on core 0.1.15: `created` → Terminal, `status` →
  `{status, records, reported}`, `title` → `{title}`, `labels` → `{labels}`,
  `foreground` → Foreground or null, `keep` → `{keep}`, `finished` →
  `{exit_code, finished_ms, reason, signal}`, `removed` → `{}`, `doc` →
  `{name, version}`.
- Errors: code -32000 with `data.kind` (`not_found`, `finished`, `blocked`,
  `conflict`, `unavailable`, …).
- Spaces and tabs live in the core document `herdr-app`: `spaces[] {id, name,
  folder, tabs[] {id, name, root}}`, `root` a pane tree (`row` / `block` with
  `content.terminal`). A tab can hold several terminals. The home space has
  `name: ""` (shown as `~`).
- Every herdr terminal has `HC_TERMINAL_ID` in its env. `terminal.send` from an
  API client without `caller` arrives as plain text (`hc send` from a terminal
  wraps it in `<hc from="t7">`).
- herdr-core starts programs without the user's interactive shell setup, so
  the bridge runs through `zsh -lic`; herdr-app wraps `argv` in the user's
  login shell itself.
- herdr-app CLI: `herdr-app do <command> '<json object>'` prints JSON, exit 0,
  or `{"error": …}` and exit 1; needs the app window running.

## Agent hooks

- Claude Code and Grok share the hook format. Grok's global hooks live in
  `~/.grok/hooks/*.json`; docs in `~/.grok/docs/user-guide/10-hooks.md`.
- `Stop` carries the final reply: `last_assistant_message` (Claude Code; else
  read `transcript_path`) or `lastAssistantMessage` (Grok, which also fires a
  session-end `Stop` with `reason` ≠ `end_turn`). Subagent stops carry
  `agent_id` / `subagentType` and are skipped.
- `PreToolUse` fires before every tool call (no matcher = all tools); the hook
  reads only the transcript's last 256 KB (transcripts reach tens of MB) and
  waits at most 0.5 s for the bridge. In a Claude Code transcript the text
  between actions is its own `assistant` line, written before the `tool_use`.

## Stack

Node 24, pnpm, TypeScript 7 (`tsc --noEmit`, strict,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
`verbatimModuleSyntax`, `.ts` imports), tsx in development, Effect 4, vitest 5 +
`@effect/vitest`, discord.js 14. Effect 4 differs a lot from v3: read
`node_modules/effect/AGENTS.md` and its ai-docs before writing Effect code.

Telegram (Bot API, verified live 2026-11-03): one forum supergroup, the bot an
admin with Manage topics; `owner` / `group` in the section, `TELEGRAM_TOKEN`.
A topic is created by clients only with its first message
(`forum_topic_created`, then that message). Bots never hear of a deleted
topic: `editForumTopic` with the same name answers `TOPIC_NOT_MODIFIED` for a
live one and `TOPIC_ID_INVALID` for a deleted one, so the adapter checks its
topics every minute and reports `thread.deleted`; a closed topic
(`forum_topic_closed`) is reported at once and then deleted. Sending to a
deleted topic fails ("message thread not found"), never lands in General. In
a topic, a message that replies to nothing has `reply_to_message` = the
topic's creation message. HTML parse mode (`<b>`, `<pre><code
class="language-x">`, `<blockquote>`); refused markup is resent plain. Text
4096, callback data 64 bytes (longer action ids get short keys in memory),
rate limits ~20 messages a minute per group (429 `retry_after`: waited up to
20 s). One `getUpdates` reader per token (409 otherwise). Private chats with
the bot may have topics on (messages carry a thread id; replies to the chat
id land fine).

Discord limits: 2000 chars per message, ~5 messages / 5 s per channel, 500
channels per guild, 50 per category, **2 renames per channel per 10 minutes**
(rename only on a real change). `CHANNEL_CREATE` has no author. discord.js
queues within limits; waits over 5 s are refused (`rest.rejectOnRateLimit`), and
a refused rename or topic is skipped with a log line (the next sync retries),
so nothing holds the bridge's single loop. Every bridge → adapter call also
times out after 30 s (`callTimeout` in `chat/Adapters.ts`). Gateway identifies
(1000 a day) happen once per adapter start; resumes don't count.
