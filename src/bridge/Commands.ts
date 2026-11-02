/**
 * The commands the bridge registers with every adapter (slash commands on
 * Discord). Adapters answer only the owner.
 */
import type { Agent } from "../Config.ts"
import type { CommandSpec } from "../protocol/Chat.ts"

export const specs = (agents: Readonly<Record<string, Agent>>): ReadonlyArray<CommandSpec> => [
  {
    name: "screen",
    description: "Show the screen of this tab's agent",
    options: []
  },
  {
    name: "status",
    description: "What every agent is doing",
    options: []
  },
  {
    name: "space new",
    description: "Make a herdr space on the Mac (needs the herdr app open)",
    options: [
      { name: "name", description: "Space name", type: "string", required: true },
      { name: "folder", description: "Folder its terminals start in, e.g. ~/Projects/api", type: "string", required: true },
      { name: "agent", description: "Who works in its first tab", type: "string", required: false, choices: Object.keys(agents) },
      { name: "task", description: "First message for the agent", type: "string", required: false }
    ]
  }
]
