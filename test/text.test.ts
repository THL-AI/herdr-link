import { assert, describe, it } from "@effect/vitest"
import { chunk } from "../src/bridge/Text.ts"

describe("chunk", () => {
  it("keeps short text whole", () => {
    assert.deepStrictEqual(chunk("hello", 2000), ["hello"])
  })

  it("splits at paragraph breaks and respects the limit", () => {
    const text = Array.from({ length: 30 }, (_, i) => `paragraph ${i} `.repeat(10)).join("\n\n")
    const parts = chunk(text, 300)
    assert.isTrue(parts.length > 1)
    for (const part of parts) assert.isAtMost(part.length, 300)
    assert.strictEqual(parts.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " ").trim())
  })

  it("closes and reopens a code block cut in two", () => {
    const code = Array.from({ length: 40 }, (_, i) => `const x${i} = ${i}`).join("\n")
    const parts = chunk(`Here:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nDone.`, 300)
    for (const part of parts) {
      assert.isAtMost(part.length, 300)
      const fences = part.split("\n").filter((line) => line.startsWith("```")).length
      assert.strictEqual(fences % 2, 0, part)
    }
    assert.isTrue(parts[1]!.startsWith("```ts\n"))
  })

  it("cuts a long word hard", () => {
    const parts = chunk("x".repeat(250), 100)
    assert.isTrue(parts.every((p) => p.length <= 100))
    assert.strictEqual(parts.join(""), "x".repeat(250))
  })
})
