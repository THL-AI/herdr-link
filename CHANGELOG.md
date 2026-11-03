# Changelog

What changed in each release of herdr-link. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/) (before 1.0, a minor version may
change the config or the chat protocol). Where it's heading:
[roadmap](docs/roadmap.md).

## Unreleased

### Fixed

- The Herdr bar's panel opens under the bar, not wherever the pointer last
  was in the main window.

## 0.6.1 (2026-11-03)

### Changed

- The package ships compiled JavaScript instead of TypeScript run through
  tsx: installing no longer pulls in tsx and esbuild, and npm no longer
  warns about esbuild's install script.

## 0.6.0 (2026-11-03)

### Added

- **Install with an agent:** tell your coding agent "Read
  https://thl-ai.github.io/herdr-link/install.md and install herdr-link for
  me." It checks your computer, installs what's missing (asking first),
  walks you through the bot and checks the result; the bot token never goes
  through the agent. On the site as
  [Install with an agent](docs/install-with-an-agent.md).
- **Adapters that drive agents.** The Chat protocol gains what a program
  (not only a chat app) needs to run agents through herdr-link:
  - `space.create`: make a herdr space, with a first tab running an agent on
    a task; answers with its room and thread;
  - `thread.created` takes `agent` and `task`: the tab starts at once with
    that agent and its first message;
  - `room.deleted`: deleting a space's room closes the space in herdr. On
    Discord: delete a space's category, and the space closes; its channels
    go to the archive;
  - `thread.status` (with the new `status` capability): every agent's state
    as data, on each change.

## 0.5.0 (2026-11-03)

### Added

- **Question forms in the chat.** When Claude Code asks with its question
  form (AskUserQuestion), each question arrives in the tab's thread with its
  options as buttons: one tap for a single choice, check marks and Next for
  a multi select, Submit at the end. Write your own answer in the thread
  instead; on a multi-select question that closes the form and your words go
  to the agent as a message. Answered in herdr, the buttons go away.
- **At the desk or away.** At the desk, messages still arrive in the chat,
  without a push (Discord's silent messages, Telegram's
  `disable_notification`); away, every message pushes as before.
  `herdr-link desk on | off`.
- **A bar in the Herdr window** (`herdr-link mod install`): whether the link
  works (green, yellow, red), your chat apps, the desk switch. Click it for
  the panel: turn a chat app or its DM status on and off, update the hooks,
  restart, run the doctor, read the log.
- `herdr-link status [--json]`: what the running bridge reports (chat apps
  connected or their last error, the hooks, the desk switch), from
  `~/.local/state/herdr-link/status.json`.
- `herdr-link adapter <name> on | off` and `herdr-link adapter <name>
  dashboard on | off`: change one line of the config, keep the rest
  (comments too), restart the service.
- `herdr-link service restart`.
- Chat protocol: optional `silent` on `message.post` and `ask`. Adapters
  that can't post silently post normally.

## 0.4.0 (2026-11-03)

### Added

- **Telegram**, built in (`herdr-link-telegram`): every herdr tab is a topic
  `✳️space / tab` of one forum group; the bot's private chat is the control
  room. Buttons, a `/` command menu, files. Deleting or closing a topic
  closes its tab.
- `herdr-link telegram`: finds the group and user ids, checks Topics and the
  bot's admin rights, prints the config section.
- **Progress on long turns:** a turn still working after 45 s gets one
  status message in its thread, edited live with the time spent and the
  agent's latest notes, shrunk to "✅ worked 12 min" at the end. The hook
  also runs on `PreToolUse` now: run `herdr-link hooks install` again.
- New threads in chat apps without rooms: the name says the space
  (`✳️api / fix`), or the bot asks which. Messages written before the tab
  is up become its agent's first task.
- `enabled = false` and `dashboard = false` in an adapter's section.

### Fixed

- The DM dashboard was reposted after every layout change; it is now edited
  in place and reposted only when the old message is gone.

## 0.3.4 (2026-11-02)

### Added

- `herdr-link init` installs herdr when it is missing (after asking).
- A [roadmap](docs/roadmap.md) to 1.0, and Getting started on the site.

## 0.3.3 (2026-11-02)

### Fixed

- No stalls behind Discord's rate limits: a rename Discord postpones is
  skipped and retried by the next sync, and every call to an adapter times
  out after 30 s.

## 0.3.2 (2026-11-02)

### Fixed

- `herdr-link doctor` waits out Discord's rate limit (it shares the bot
  token with the running bridge) instead of failing.

## 0.3.1 (2026-11-02)

### Added

- The site: a landing page and the docs, on GitHub Pages.
- Docs for agents: adding one, finding its keys.

## 0.3.0 (2026-11-02)

### Added

- Docs: configuration, agents, writing an adapter (the protocol, examples,
  a small Python adapter), troubleshooting.
- `herdr-link doctor --fix [--yes]`: every check knows its fix (hooks, the
  service, Discord's Message Content intent, starting herdr-core, `init`).
- Adapters without rooms: tabs become top-level threads `<space> / <tab>`.

## 0.2.0 (2026-11-02)

### Added

- **Split tabs:** several panes share their tab's thread; their messages are
  signed, a reply goes back to the pane that wrote the message, a leading
  agent emoji picks that agent, else the bot asks "Who is this for?".
- **Several machines:** spaces on another herdr machine carry its name; a
  `machine` setting names this computer when herdr-link runs on several.

## 0.1.1 (2026-11-02)

### Changed

- Published through npm trusted publishing, with provenance.

## 0.1.0 (2026-11-02)

First release: herdr spaces as private rooms and tabs as threads on
Discord, agent replies through a shared hook, permission prompts with
Allow / Allow always / Deny, new tabs from new threads, an archive for
closed tabs, `/screen`, `/status`, `/space new`, the DM control room. The
`herdr-link` CLI: `init`, `doctor`, `service`, `hooks`.
