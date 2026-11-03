# Roadmap

Where herdr-link is going, and what has to be true before it is called 1.0.

## What 1.0 means

1.0 is a promise, not a feature count. From 1.0 on, until 2.0:

- **The Chat protocol v1 is frozen.** Adapters written against it keep
  working; new things arrive only as optional methods and capabilities.
- **The config keeps loading.** `config.toml` written by any 1.x still
  works; when a key changes, the old one is still read and `doctor` says what
  to change.
- **The CLI stays put.** `init`, `doctor`, `run`, `service`, `hooks`: same
  commands, same flags.
- **Updating is boring.** `npm install -g @thl-ai/herdr-link@latest` and a
  restart, never a lost thread or a duplicated room.
- **It is proven, not just tested:** every behaviour in the docs has been
  used for real, on macOS and Linux, with more than one chat app.

Until then, minor versions (0.x) may still change the protocol and the config,
with a note in the release.

## Done

- **0.1** The bridge: spaces → rooms, tabs → threads, replies through agent
  hooks, permission buttons, new tabs from threads, the archive, commands,
  the DM control room. Discord adapter. `init`, `doctor`, `service`, `hooks`.
- **0.2** Split tabs (several agents in one tab's thread), several machines.
- **0.3** Docs and this site, `doctor --fix`, adapters without rooms, no
  stalls behind Discord's rate limits.
- **0.4** Telegram (topics as tabs, the bot's chat as the control room); a
  long turn's progress in one live status message; the first message of a
  new thread becomes its agent's task; `enabled` and `dashboard` switches.
- **0.5.0** Question forms (Claude Code's AskUserQuestion) answered from the
  chat; at the desk or away (no pushes while you sit at the computer); a bar
  in the Herdr window with the link's state and basic settings;
  `herdr-link status`, `desk`, `adapter`, `mod`.

## 0.5: proven on real use

What works in tests has to work in a real day.

- [x] `init` installs herdr when it is missing (0.3.4)
- [ ] Split tabs used live: signatures, replies to a pane, the agent emoji,
      "Who is this for?"
- [ ] A rename postponed by Discord's rate limit, seen live and caught up
- [ ] A clean Linux machine, start to finish: herdr, `init`, the systemd
      unit, hooks, a reboot
- [ ] Restarts on every side: herdr-core, the herdr app, the bridge, the
      adapter, the computer asleep for a night; nothing lost, nothing doubled
- [ ] Supported herdr versions written down and checked by `doctor`
- [ ] Update from an older herdr-link without losing a thread

## 0.6: a second chat app

The protocol claims to be chat-agnostic. A second adapter proves it, and
whatever it finds missing goes in before the freeze.

- [x] A Telegram adapter (forum topics as threads, the bot's private chat as
      the control room) (0.4.0)
- [ ] `init` sets up Telegram too
- [ ] An adapter test kit: a fake bridge that runs an adapter through the
      whole protocol, so adapter authors know theirs works
- [ ] Protocol fixes the second adapter asks for, while they are still cheap

## 0.7: more agents, better on the phone

- [ ] More agents with verified keys: Codex CLI, Gemini CLI, opencode
- [ ] `/screen` that follows the agent for a while instead of one snapshot
- [x] At the desk or away: no pushes while you sit at the computer; a bar
      in the Herdr window with the link's state and basic settings
- [ ] The dashboard pinned in the DM
- [ ] Clearer messages when something is off: herdr app closed, agent
      signed out, a hook missing

## 0.9: release candidate

- [ ] Protocol v1 frozen: `schema/chat.openrpc.json` marked stable
- [ ] Config format frozen; anything renamed on the way still read
- [ ] Security review: owner checks in every adapter path, the hook socket,
      the adapter environment, what reaches the chat
- [ ] Docs checked line by line against the code
- [ ] Used daily for two weeks without touching the code

## 1.0

The 0.9 candidate, with whatever those two weeks turned up fixed.

## After 1.0

Ideas, in no order: a read-only room for a client on one project, Slack and
Matrix adapters, several owners on one server, a live terminal view.

Something missing here? [Open an issue](https://github.com/THL-AI/herdr-link/issues).
