/**
 * Text helpers of the Telegram adapter: the bridge's Markdown (the Discord
 * subset) as Telegram HTML, and slash command arguments parsed from text.
 */
import type { CommandArgs, CommandSpec } from "../../protocol/Chat.ts"

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;")

/** Bold, italics, strike-through, spoilers and links in text already escaped. */
const spans = (text: string) =>
  text
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "<a href=\"$2\">$1</a>")
    .replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+?)__/g, "<u>$1</u>")
    .replace(/~~([^~\n]+?)~~/g, "<s>$1</s>")
    .replace(/\|\|([^|\n]+?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>")
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, "$1<i>$2</i>")
    .replace(/(^|[^_\w])_([^_\n]+?)_(?![_\w])/g, "$1<i>$2</i>")

/** Headings and Discord's small text as bold / italic lines, `>` lines as a quote. */
const lines = (text: string) => {
  const out: Array<string> = []
  let quote: Array<string> = []
  const flush = () => {
    if (quote.length > 0) out.push(`<blockquote>${quote.join("\n")}</blockquote>`)
    quote = []
  }
  for (const line of text.split("\n")) {
    const quoted = /^&gt; ?(.*)$/.exec(line)
    if (quoted !== null) {
      quote.push(quoted[1]!)
      continue
    }
    flush()
    const heading = /^#{1,3} (.+)$/.exec(line)
    const small = /^-# (.+)$/.exec(line)
    out.push(heading !== null ? `<b>${heading[1]}</b>` : small !== null ? `<i>${small[1]}</i>` : line)
  }
  flush()
  return out.join("\n")
}

/** Text outside code blocks: inline code kept verbatim, the rest formatted. */
const inline = (text: string) => {
  const parts: Array<string> = []
  let last = 0
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    parts.push(spans(escape(text.slice(last, match.index))))
    parts.push(`<code>${escape(match[1]!)}</code>`)
    last = match.index + match[0].length
  }
  parts.push(spans(escape(text.slice(last))))
  return lines(parts.join(""))
}

/**
 * Markdown as Telegram HTML. Anything it gets wrong makes Telegram refuse the
 * message; the adapter then sends the original text plain.
 */
export const toHtml = (markdown: string): string => {
  const out: Array<string> = []
  let last = 0
  for (const match of markdown.matchAll(/```(?:([\w+-]*)\n)?([\s\S]*?)```/g)) {
    out.push(inline(markdown.slice(last, match.index)))
    const lang = match[1] ?? ""
    const code = escape(match[2]!.replace(/\n$/, ""))
    out.push(lang === "" ? `<pre>${code}</pre>` : `<pre><code class="language-${lang}">${code}</code></pre>`)
    last = match.index + match[0].length
  }
  out.push(inline(markdown.slice(last)))
  return out.join("")
}

/** Words of a command line; "double quotes" keep spaces. */
const words = (text: string) => [...text.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!)

const usage = (spec: CommandSpec) =>
  `/${spec.name} ${spec.options.map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`)).join(" ")}`.trim()

export type Parsed =
  | { readonly _tag: "command"; readonly command: string; readonly args: CommandArgs }
  | { readonly _tag: "usage"; readonly text: string }
  | { readonly _tag: "unknown" }

/**
 * `/space new api ~/Projects/api claude fix the login`: positional
 * arguments in the spec's order. An optional argument with choices is taken
 * only when the word is one of them; the last text argument takes the rest.
 * `/status@herdr_bot` is accepted when `bot` is that name.
 */
export const parseCommand = (text: string, specs: ReadonlyArray<CommandSpec>, bot: string): Parsed => {
  const head = /^\/([a-z0-9_]+)(?:@(\w+))?(?:\s+|$)/i.exec(text)
  if (head === null || (head[2] !== undefined && head[2].toLowerCase() !== bot.toLowerCase())) return { _tag: "unknown" }
  const name = head[1]!.toLowerCase()
  let rest = words(text.slice(head[0].length))
  let spec = specs.find((s) => s.name === `${name} ${rest[0]?.toLowerCase()}`)
  if (spec !== undefined) rest = rest.slice(1)
  else spec = specs.find((s) => s.name === name)
  if (spec === undefined) {
    const subs = specs.filter((s) => s.name.startsWith(`${name} `))
    return subs.length === 0 ? { _tag: "unknown" } : { _tag: "usage", text: subs.map(usage).join("\n") }
  }
  const args: Record<string, string | number | boolean> = {}
  const options = spec.options
  for (const [index, option] of options.entries()) {
    if (rest.length === 0) {
      if (option.required) return { _tag: "usage", text: usage(spec) }
      continue
    }
    const word = rest[0]!
    if (option.choices !== undefined) {
      if (option.choices.includes(word)) {
        args[option.name] = word
        rest = rest.slice(1)
      } else if (option.required) return { _tag: "usage", text: `${usage(spec)}\n${option.name}: one of ${option.choices.join(", ")}` }
      continue
    }
    const last = index === options.length - 1
    if (option.type === "string") {
      args[option.name] = last ? rest.join(" ") : word
      rest = last ? [] : rest.slice(1)
    } else if (option.type === "integer") {
      const value = Number(word)
      if (!Number.isInteger(value)) return { _tag: "usage", text: usage(spec) }
      args[option.name] = value
      rest = rest.slice(1)
    } else {
      args[option.name] = /^(true|yes|on|1)$/i.test(word)
      rest = rest.slice(1)
    }
  }
  return { _tag: "command", command: spec.name, args }
}

/** Top-level commands for Telegram's menu: `space new` shows up as `space`. */
export const menu = (specs: ReadonlyArray<CommandSpec>) => {
  const top = new Map<string, string>()
  for (const spec of specs) {
    const [name, sub] = spec.name.split(" ") as [string, string | undefined]
    const description = sub === undefined ? spec.description : `${usage(spec).slice(1)}: ${spec.description}`
    top.set(name, top.has(name) ? `${top.get(name)}; ${description}` : description)
  }
  return [...top].map(([command, description]) => ({
    command: command.replace(/-/g, "_"),
    description: description.slice(0, 256)
  }))
}
