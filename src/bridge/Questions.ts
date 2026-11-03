/**
 * An agent's question form (Claude Code's AskUserQuestion) in the chat: one
 * message per question, its options as buttons, answered with the keys the
 * form takes (verified on Claude Code 2.1.317):
 *
 * - single select: the option's digit picks it and moves on (the only question
 *   of a form: submits it); with previews (options shown beside a preview
 *   box) the digit only moves the cursor and Enter picks;
 * - multi select: digits toggle, `tab` moves on;
 * - your own words: on a single-select question, the digit of "Type something"
 *   (after the options) and the text with Enter; a multi-select question can't
 *   take typed text reliably, so the form is closed (`esc`) and the text goes
 *   to the agent as a normal message; a question with previews has no "Type
 *   something", so the same;
 * - a form with several questions or a multi-select one ends on a review
 *   screen: `1` submits.
 */
import type { Action } from "../protocol/Chat.ts"
import { ActionId } from "../protocol/Chat.ts"
import type { Question } from "./Hooks.ts"

/** Discord's button label limit, minus room for the check mark. */
const maxLabel = 76

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

export const optionKey = (index: number) => String(index + 1)

/** "Type something": right after the options. */
export const ownWordsKey = (question: Question) => String(question.options.length + 1)

/** The keys that pick an option of a single-select question, one screen step each. */
export const pickSteps = (question: Question, index: number): ReadonlyArray<ReadonlyArray<string>> =>
  question.preview === true ? [[optionKey(index)], ["enter"]] : [[optionKey(index)]]

/** Whether the question has a "Type something" line to type an answer into. */
export const takesWords = (question: Question) => !question.multiSelect && question.preview !== true

/** Whether the form ends on a review screen that needs `1` to submit. */
export const needsReview = (questions: ReadonlyArray<Question>) =>
  questions.length > 1 || questions.some((q) => q.multiSelect)

export const actionId = (form: number, step: number, choice: number | "next") => ActionId.make(`q:${form}:${step}:${choice}`)

export const parseAction = (action: string) => {
  const match = /^q:(\d+):(\d+):(\d+|next)$/.exec(action)
  if (match === null) return undefined
  return {
    form: Number(match[1]),
    step: Number(match[2]),
    choice: match[3] === "next" ? "next" as const : Number(match[3])
  }
}

export const text = (questions: ReadonlyArray<Question>, step: number) => {
  const q = questions[step]!
  const count = questions.length > 1 ? ` ${step + 1}/${questions.length}` : ""
  const header = q.header === undefined || q.header === "" ? "" : ` · ${q.header}`
  const options = q.options.map((o, i) =>
    `${i + 1}. **${o.label}**${o.description === undefined || o.description === "" ? "" : ` — ${o.description}`}`
  )
  const how = q.multiSelect
    ? "Tap all that fit, then Next. Or write your answer here (that closes the form)."
    : takesWords(q)
    ? "Tap one, or write your own answer here."
    : "Tap one. Or write here instead (that closes the form)."
  return [`❓ Question${count}${header}`, q.question, "", ...options, "", `-# ${how}`].join("\n")
}

export const actions = (
  form: number,
  questions: ReadonlyArray<Question>,
  step: number,
  picked: ReadonlySet<number>
): Array<Action> => {
  const q = questions[step]!
  const options = q.options.map((o, i): Action => ({
    id: actionId(form, step, i),
    label: `${q.multiSelect && picked.has(i) ? "✓ " : ""}${clip(o.label, maxLabel)}`,
    ...(q.multiSelect && picked.has(i) ? { style: "success" as const } : {})
  }))
  if (!q.multiSelect) return options
  const last = step === questions.length - 1
  return [...options, { id: actionId(form, step, "next"), label: last ? "Submit ➡" : "Next ➡", style: "primary" }]
}
