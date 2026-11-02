/** Small terminal prompts for `herdr-link init`. */
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"

export const ask = async (question: string, fallback?: string): Promise<string> => {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const answer = (await rl.question(fallback === undefined ? `${question} ` : `${question} [${fallback}] `)).trim()
    return answer === "" ? (fallback ?? "") : answer
  } finally {
    rl.close()
  }
}

export const confirm = async (question: string, fallback = true): Promise<boolean> => {
  const answer = (await ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"}`)).toLowerCase()
  return answer === "" ? fallback : answer.startsWith("y")
}

/** Reads a secret without echoing it. */
export const secret = (question: string): Promise<string> =>
  new Promise((resolve) => {
    stdout.write(`${question} `)
    let value = ""
    const raw = stdin.isTTY
    if (raw) stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          stdin.off("data", onData)
          if (raw) stdin.setRawMode(false)
          stdin.pause()
          stdout.write("\n")
          return resolve(value.trim())
        }
        if (char === "\u0003") process.exit(130)
        if (char === "\u007f") value = value.slice(0, -1)
        else value += char
      }
    }
    stdin.on("data", onData)
  })

export const ok = (text: string) => console.log(`  ✓ ${text}`)
export const bad = (text: string) => console.log(`  ✗ ${text}`)
export const note = (text: string) => console.log(`    ${text}`)
