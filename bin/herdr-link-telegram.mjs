#!/usr/bin/env node
// The built-in Telegram adapter, runnable from anywhere.
import { load } from "./load.mjs"

await load("adapters/telegram/main")
