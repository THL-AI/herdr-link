// Loads one of herdr-link's entry points. In a source checkout (src/ is here)
// the TypeScript runs through tsx, a dev dependency; the published package
// has only the compiled dist/, so installs need neither tsx nor esbuild.
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const root = join(dirname(fileURLToPath(import.meta.url)), "..")

/** `entry` without extension, relative to src/ (or dist/): "cli/main". */
export const load = async (entry) => {
  const source = join(root, "src", `${entry}.ts`)
  if (existsSync(source)) {
    const { register } = await import("tsx/esm/api")
    register()
    return import(source)
  }
  return import(join(root, "dist", `${entry}.js`))
}
