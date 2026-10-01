/**
 * One-line, human-readable summary of a held event, for veto alerts:
 * "name: pumpkin", "deletes 3 events", "2 media servers".
 */

import type { NostrEvent } from './policy.js'

const MAX = 120

function clip (s : string) : string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > MAX ? one.slice(0, MAX - 1) + '…' : one
}

export function summarize_event (ev : Pick<NostrEvent, 'kind' | 'tags' | 'content'>) : string {
  switch (ev.kind) {
    case 0: {
      try {
        const p = JSON.parse(ev.content) as Record<string, unknown>
        const parts = [ 'name', 'display_name', 'nip05', 'lud16', 'about' ]
          .filter(k => typeof p[k] === 'string' && (p[k] as string).length)
          .map(k => `${k}: ${p[k] as string}`)
        return clip(parts.length ? parts.join(', ') : 'profile with no name')
      } catch {
        return clip(`profile (not JSON): ${ev.content}`)
      }
    }
    case 5: {
      const n = ev.tags.filter(t => t[0] === 'e' || t[0] === 'a').length
      return clip(`deletes ${n} event${n === 1 ? '' : 's'}${ev.content ? `: ${ev.content}` : ''}`)
    }
    case 10063: {
      const servers = ev.tags.filter(t => t[0] === 'server').map(t => t[1])
      return clip(`${servers.length} media server${servers.length === 1 ? '' : 's'}: ${servers.join(', ')}`)
    }
    default:
      return clip(ev.content || `kind ${ev.kind}`)
  }
}
