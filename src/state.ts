/**
 * Policy state on disk, so a share node keeps its rate-limit counters and
 * held (delay-gated) events across restarts. Without it a restart reset
 * "3 per day" to zero and restarted every 24h delay.
 *
 * Writes are atomic (temp file + rename) and private (mode 600). A corrupt
 * file stops the node instead of silently starting with empty counters.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { PolicyState } from './policy.js'

export function load_policy_state (path : string) : PolicyState | undefined {
  if (!existsSync(path)) return undefined
  let state : PolicyState
  try {
    state = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`cinderella: policy state ${path} is unreadable (${err instanceof Error ? err.message : String(err)}); fix or remove it deliberately`)
  }
  if (state?.version !== 1 || typeof state.history !== 'object' || typeof state.pending !== 'object') {
    throw new Error(`cinderella: policy state ${path} has an unexpected format; fix or remove it deliberately`)
  }
  return state
}

export function save_policy_state (path : string, state : PolicyState) : void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
  renameSync(tmp, path)
}
