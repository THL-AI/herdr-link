/**
 * Splits text into messages of at most `max` characters: at a blank line,
 * else a line break, else a space, else hard. A code block cut in two is
 * closed at the end of one part and reopened (same language) in the next.
 */
const fence = /^(\s*)(```+|~~~+)(.*)$/

/** The fence still open at the end of `text`, e.g. "```ts", or undefined. */
const openFence = (text: string): string | undefined => {
  let open: string | undefined
  for (const line of text.split("\n")) {
    const match = fence.exec(line)
    if (match === null) continue
    open = open === undefined ? `${match[2]}${match[3]?.trim() ?? ""}` : undefined
  }
  return open
}

const cutAt = (text: string, max: number) => {
  const window = text.slice(0, max)
  for (const separator of ["\n\n", "\n", " "]) {
    const at = window.lastIndexOf(separator)
    if (at > max / 2) return at
  }
  return max
}

export const chunk = (text: string, max: number): Array<string> => {
  const parts: Array<string> = []
  let rest = text.trim()
  let reopen = ""
  // Leave room for a closing fence and a reopened one.
  const room = Math.max(max - 16, 1)
  while (rest !== "") {
    const body = reopen + rest
    if (body.length <= max) {
      parts.push(body)
      break
    }
    const at = cutAt(body, room)
    let part = body.slice(0, at).trimEnd()
    const open = openFence(part)
    if (open !== undefined) part += "\n```"
    parts.push(part)
    rest = body.slice(at).replace(/^(\n+| )/, "")
    reopen = open === undefined ? "" : `${open}\n`
  }
  return parts
}

const fileLine = /^\s*\[file:\s*(.+?)\s*\]\s*$/

/**
 * The files an agent's reply sends: lines `[file: /absolute/path]` (the form
 * the owner's attachments reach the agent in), taken out of the text. Lines
 * inside code blocks stay: there the agent is showing the form, not using it.
 */
export const takeFiles = (text: string): { readonly text: string; readonly paths: ReadonlyArray<string> } => {
  const kept: Array<string> = []
  const paths: Array<string> = []
  let inCode = false
  for (const line of text.split("\n")) {
    if (fence.test(line)) inCode = !inCode
    const match = inCode ? null : fileLine.exec(line)
    if (match === null) kept.push(line)
    else paths.push(match[1]!)
  }
  return paths.length === 0 ? { text, paths } : { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), paths }
}
