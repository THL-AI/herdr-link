#!/usr/bin/env node
// Builds the static site into _site/: the landing page as is, plus docs/*.md
// rendered to HTML pages in the same style. Run by the Pages workflow; locally:
// `pnpm site`, then open _site/index.html.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Marked } from "marked"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const out = join(root, "_site")
const repo = "https://github.com/THL-AI/herdr-link"

/** The docs, in sidebar order. */
const pages = [
  { file: "getting-started", label: "Getting started" },
  { file: "configuration", label: "Configuration" },
  { file: "agents", label: "Agents" },
  { file: "adapters", label: "Writing an adapter" },
  { file: "troubleshooting", label: "Troubleshooting" }
]

const slug = (text) =>
  text.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")

const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** `adapters.md#x` → `adapters.html#x`; `../schema/x.json` → the file on GitHub. */
const rewriteHref = (href) => {
  if (/^[a-z]+:/i.test(href) || href.startsWith("#")) return href
  const [path, hash] = href.split("#")
  if (path.endsWith(".md") && !path.includes("/")) return `${path.replace(/\.md$/, ".html")}${hash ? `#${hash}` : ""}`
  const target = path.replace(/^(\.\.\/)+/, "").replace(/^\.\//, "docs/")
  return `${repo}/blob/main/${target}${hash ? `#${hash}` : ""}`
}

const markdown = (headings) =>
  new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens)
        const id = slug(html)
        if (depth === 2 || depth === 3) headings.push({ depth, id, html })
        // "## 2. Create the bot": a numbered step, drawn with a badge.
        const step = depth === 2 ? /^(\d+)\.\s+(.*)$/s.exec(html) : null
        if (step !== null) {
          return `<h2 id="${id}" class="step"><a class="anchor" href="#${id}"><span class="n">${step[1]}</span>${step[2]}</a></h2>\n`
        }
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}">${html}</a></h${depth}>\n`
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens)
        const target = rewriteHref(href)
        const external = target.startsWith("http") && !target.startsWith(repo) ? ' rel="noopener"' : ""
        return `<a href="${target}"${title ? ` title="${escape(title)}"` : ""}${external}>${text}</a>`
      },
      table(token) {
        // Wide tables scroll on phones instead of stretching the page.
        return `<div class="table">${this.constructor.prototype.table.call(this, token)}</div>`
      }
    }
  })

const style = `
:root { --bg:#0e0f11; --surface:#16181b; --raised:#1f2125; --line:#2b2e33; --text:#f3f3f4; --soft:#c4c7cd; --muted:#8a8e96; --accent:#e8912a;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color-scheme: dark; }
@media (prefers-color-scheme: light) { :root { --bg:#f6f5f2; --surface:#fff; --raised:#efeee9; --line:#dedcd6; --text:#16181b; --soft:#3d4046; --muted:#6b6f77; --accent:#c76f0b; color-scheme: light; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.65 var(--sans); }
a { color: var(--accent); }
.top { border-bottom: 1px solid var(--line); }
.top .in { max-width: 1180px; margin: 0 auto; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
.brand { display: flex; align-items: center; gap: 10px; color: var(--text); font-weight: 700; text-decoration: none; }
.brand img { width: 28px; height: 28px; }
.top nav { display: flex; gap: 20px; font-size: 15px; }
.top nav a { color: var(--soft); text-decoration: none; }
.layout { max-width: 1180px; margin: 0 auto; padding: 0 24px; display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 48px; }
aside { padding: 32px 0; position: sticky; top: 0; align-self: start; max-height: 100vh; overflow: auto; }
aside .group { font: 600 12px var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: .06em; margin: 0 0 10px; }
aside a { display: block; color: var(--soft); text-decoration: none; padding: 6px 10px; border-radius: 8px; font-size: 15px; }
aside a:hover { color: var(--text); }
aside a.on { background: var(--raised); color: var(--text); font-weight: 600; }
aside .toc { margin: 4px 0 10px 10px; border-left: 1px solid var(--line); }
aside .toc a { font-size: 13.5px; padding: 3px 10px; color: var(--muted); }
main { padding: 32px 0 80px; min-width: 0; max-width: 780px; }
h1 { font-size: 36px; letter-spacing: -.02em; line-height: 1.15; margin: 0 0 16px; }
h2 { font-size: 24px; letter-spacing: -.01em; margin: 44px 0 12px; padding-top: 8px; }
h3 { font-size: 18px; margin: 28px 0 8px; }
h2.step a { display: flex; align-items: center; gap: 12px; }
h2.step .n { flex: none; width: 34px; height: 34px; border-radius: 50%; background: var(--accent); color: var(--bg); display: grid; place-items: center; font: 700 17px var(--sans); }
h1 a.anchor, h2 a.anchor, h3 a.anchor { color: inherit; text-decoration: none; }
p, li { color: var(--soft); }
strong { color: var(--text); }
code { font-family: var(--mono); font-size: .88em; background: var(--raised); padding: 1px 5px; border-radius: 5px; color: var(--text); }
pre { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px; overflow-x: auto; font-size: 13.5px; line-height: 1.55; }
pre code { background: none; padding: 0; font-size: inherit; color: var(--soft); }
.table { overflow-x: auto; margin: 16px 0; border: 1px solid var(--line); border-radius: 12px; }
table { border-collapse: collapse; width: 100%; font-size: 14.5px; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { background: var(--surface); color: var(--text); font-weight: 600; }
tr:last-child td { border-bottom: 0; }
td { color: var(--soft); }
.foot { margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--line); font-size: 14px; color: var(--muted); display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.foot a { color: var(--soft); }
@media (max-width: 860px) {
  .layout { grid-template-columns: 1fr; gap: 0; }
  aside { position: static; max-height: none; padding: 16px 0 0; display: flex; gap: 6px; flex-wrap: wrap; }
  aside .group, aside .toc { display: none; }
  aside a { border: 1px solid var(--line); }
  main { padding-top: 16px; }
}
@media (max-width: 560px) { .top .in, .layout { padding: 0 16px; } .top .in { padding-top: 14px; padding-bottom: 14px; } h1 { font-size: 30px; } }
`

const render = (page) => {
  const headings = []
  const source = readFileSync(join(root, "docs", `${page.file}.md`), "utf8")
  const body = markdown(headings).parse(source)
  const title = source.match(/^# (.+)$/m)?.[1] ?? page.label
  const sidebar = pages.map((p) => {
    const on = p.file === page.file
    const toc = on && headings.length > 0
      ? `<div class="toc">${headings.filter((h) => h.depth === 2).map((h) => `<a href="#${h.id}">${h.html}</a>`).join("")}</div>`
      : ""
    return `<a href="${p.file}.html"${on ? ' class="on"' : ""}>${p.label}</a>${toc}`
  }).join("")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · herdr-link docs</title>
<link rel="icon" href="../logo.svg" type="image/svg+xml">
<style>${style}</style>
</head>
<body>
<div class="top"><div class="in">
  <a class="brand" href="../"><img src="../logo.svg" alt="">herdr-link</a>
  <nav><a href="getting-started.html">Docs</a><a href="${repo}">GitHub</a></nav>
</div></div>
<div class="layout">
  <aside><div class="group">Docs</div>${sidebar}</aside>
  <main>
${body}
    <div class="foot"><a href="${repo}/edit/main/docs/${page.file}.md">Edit this page on GitHub</a><span>herdr-link · MIT</span></div>
  </main>
</div>
</body>
</html>
`
}

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, "docs"), { recursive: true })
cpSync(join(root, "site", "index.html"), join(out, "index.html"))
cpSync(join(root, "assets", "logo.svg"), join(out, "logo.svg"))
for (const page of pages) writeFileSync(join(out, "docs", `${page.file}.html`), render(page))
writeFileSync(
  join(out, "docs", "index.html"),
  `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=getting-started.html"><link rel="canonical" href="getting-started.html">`
)
console.log(`built ${out}: index.html, ${pages.length} docs`)
