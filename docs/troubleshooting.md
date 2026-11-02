# Troubleshooting

Start with:

```sh
herdr-link doctor        # checks herdr, the config, the chat adapters, the agent hooks and the bridge
herdr-link doctor --fix  # and fixes what it can
```

`--fix` installs or reinstalls the agent hooks, installs or restarts the
service, turns on Discord's Message Content intent, starts a stopped
herdr-core and, after asking, installs herdr itself with its official script.
For a missing config or a broken token it runs `herdr-link init`. Add `--yes`
to skip the questions.

Logs: `herdr-link service logs` (macOS: `~/Library/Logs/herdr-link.log`, Linux:
`journalctl --user -u herdr-link`).

## Common problems

**The agent works, but its replies don't reach the chat.**
The hook is missing or points to an old install (after a reinstall or moving
the checkout). `herdr-link hooks install`, then restart the agent's session:
agents read their hooks when a session starts.

**No push notifications on the phone.**
On Discord, servers default to "only @mentions" for big servers. Right-click
each of the bot's categories → Notification Settings → All Messages.

**No Allow / Deny buttons.**
The agent didn't ask: Claude Code in auto mode and Grok with safe commands
don't. When it does ask and there are still no buttons, its `allow` / `deny`
keys are missing from the config.

**"Who is this for?" on every message.**
The tab is split into several panes. Reply to the pane's message, or start
with its agent's emoji (`✳️ …`), to skip the question.

**New channel, but no new tab.**
New tabs need the herdr app's window running (tabs live in the app). The
channel must be in one of the bot's categories, not in `📦 archive` or your own.

**"another herdr-link is already running".**
Only one bridge runs per user. Either the service is running (`herdr-link
service status`) and you started a second one with `herdr-link run`, or an
old process is left: `herdr-link service uninstall`, then install it again.

**Two computers, double answers in the DM.**
Two bridges share one bot. Give each computer its own bot (`herdr-link init`
on it) and set `machine` in each config.

**Grok shows "Sign in to Grok".**
Grok isn't signed in on this machine. Start `grok` in a tab and finish the
sign-in in the browser.
