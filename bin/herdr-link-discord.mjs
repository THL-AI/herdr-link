#!/usr/bin/env node
// The built-in Discord adapter, runnable from anywhere.
import { load } from "./load.mjs"

await load("adapters/discord/main")
