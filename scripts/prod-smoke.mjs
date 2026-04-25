#!/usr/bin/env node

import { formatSmokeResult, runProdSmoke } from '../dist/prodSmoke.js'

const result = await runProdSmoke({
  baseUrl: process.env.BLACKICE_BASE_URL,
  apiToken: process.env.BLACKICE_API_TOKEN,
  venue: process.env.BLACKICE_SMOKE_VENUE,
  allowNonPaperVenue: process.env.BLACKICE_SMOKE_ALLOW_NON_PAPER === '1',
  timeoutMs:
    process.env.BLACKICE_SMOKE_TIMEOUT_MS === undefined
      ? undefined
      : Number.parseInt(process.env.BLACKICE_SMOKE_TIMEOUT_MS, 10),
})

const output = formatSmokeResult(result)
if (output) {
  console.log(output)
}

if (!result.ok) {
  process.exitCode = 1
}
