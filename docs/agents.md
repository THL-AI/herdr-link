# Agents

An agent is any program running in a herdr tab. herdr-link knows an agent from
its `[agents.*]` entry in the config: how to start it, which emoji names it,
and which keys answer its permission prompts. Claude Code and Grok come set
up; adding another is configuration, not code.

## What herdr-link uses

| feature | comes from |
| --- | --- |
| "✅ Done", "⚠️ Needs you", 🔐 permission prompts | the agent's **status in herdr** (`working`, `done`, `blocked` with kind `permission` / `question` / `auth`). herdr reports it for the agents it supports. |
| the agent's reply in the chat | the **shared hook** (below), after each turn |
| progress on a long turn | the agent's status (`working`) for the time, and the shared hook for its latest notes |
| typing your messages | `terminal.send`: works with any program |
| Allow / Deny buttons | the agent's `allow` / `always` / `deny` / `trust` keys, pressed with `terminal.keys` |
| question forms with buttons | the shared hook's `PreToolUse` of Claude Code's `AskUserQuestion` (the questions and options), then the form's keys: an option's digit, `tab`, "Type something" for your own words, `1` to submit. Without it a question shows as "⚠️ Needs you". |
| starting it in a new tab | `argv`, or `template` (run as a program of that name) |
| recognizing it in a tab | `template`, then the status's `app` (`claude-code` → `claude`), then the program's name |

An agent herdr has no status for still works for messages and replies; it
just never shows "Done", "Needs you" or buttons.

## Adding one

```toml
[agents.codex]
argv = ["codex"]       # how a new tab starts it (or: template = "codex")
emoji = "🟦"           # a Unicode emoji: used in thread names and to pick it (🟦api)
logo = "codex"         # optional: a custom emoji the chat adapter knows, for buttons
allow = ["1"]          # keys for "yes" on its permission prompt
always = ["2"]         # optional: "yes, and don't ask again"
deny = ["esc"]         # "no"
trust = ["y"]          # optional: "do you trust this folder?"
```

### Finding the keys

Don't guess them: an agent's prompt changes between versions, and a wrong key
can approve the wrong thing.

1. Start the agent in a throwaway folder in a mode that asks before acting.
2. Ask it for something that needs permission (`rm` a file, run a command).
3. Look at the prompt: does a digit act at once, or does it need Enter? Is
   `esc` "no"? Note any option that turns on "approve everything": never map a
   button to it.
4. Press your candidate keys with `hc keys <terminal> <keys…>` and watch the
   result (`hc read <terminal>`, `hc get <terminal>` for the status).

Verified so far (also in `config.example.toml`):

- **Claude Code 2.1**: `1` Yes, `2` Yes and don't ask again, `esc` No (it then
  asks what to do instead).
- **Grok Build**: `3` Yes, `2` always allow this command, `4` No; `1` turns on
  always-approve for everything, so it is never used. A new folder first asks
  "do you trust this folder?" (`y`).

## Replies: the shared hook

After each turn, the agent's final answer goes to the chat through one hook
script, `hooks/herdr-link-hook.mjs`. On a long turn, the same hook also
brings the agent's latest note (the short text it writes between actions)
before each tool call; herdr-link shows the last few in the turn's status
message. `herdr-link hooks install` registers it
for Claude Code (`~/.claude/settings.json`) and Grok (`~/.grok/hooks/`).

Any agent with **Claude-compatible hooks** can use it as is: register the
command `node <path>/hooks/herdr-link-hook.mjs` for its `Stop`, `StopFailure`,
`Notification` and `PreToolUse` events. The hook reads the event from stdin
(`hook_event_name` / `hookEventName`, and `last_assistant_message`,
`lastAssistantMessage` or `transcript_path` for the reply; notes come from the
end of a Claude Code style `transcript_path`).

An agent with another hook system (or a wrapper script) can talk to the
bridge directly. Connect to the unix socket
`~/.local/state/herdr-link/hooks.sock` (or `$HERDR_LINK_SOCKET`) and write one
JSON line:

```json
{"terminal": "t7", "event": "Stop", "text": "Fixed: the import was missing."}
```

- `terminal`: the herdr terminal, from the `HC_TERMINAL_ID` environment
  variable every herdr terminal has.
- `event`: `Stop` (a turn ended; `text` is the reply), `StopFailure` (a turn
  failed; `error` says why), `Notification`, or `PreToolUse` (`text` is the
  agent's latest note, shown in the turn's progress; send it only when it
  changed is fine, repeats are ignored; `questions`, the form the agent is
  about to show, in Claude Code's AskUserQuestion shape: `[{question, header?,
  multiSelect, options: [{label, description?}]}]`).
- Keep it fast and never fail the agent: if the socket is missing, no bridge
  is running; just exit.

## Files

The owner's attachments reach the agent as lines `[file: /path]` (each file
put beside the terminal). The other way round, a line of the same form in a
reply sends that file: the line is taken out of the text, and the file (an
absolute path or one under `~`, at most 8 MB) goes to every chat that takes
files; the others get its path. Lines inside code blocks are left alone. An
agent learns this from its instructions, for example a line in
`~/.claude/CLAUDE.md`:

```markdown
To send the owner a file (a screenshot, a log), put `[file: /absolute/path]`
on its own line in your reply.
```
