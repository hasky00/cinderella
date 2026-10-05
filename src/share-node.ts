/**
 * Build a Cinderella share node: a bifrost signer with the policy middleware,
 * refusal replies and nonce resync attached. Used by node.ts and the tests, so
 * both run the exact same wiring.
 *
 * On connect it tells every peer to drop the nonces it holds from us (our
 * pool lives in memory, so after a restart they are all dead).
 */

import { BifrostNode }              from '@frostr/bifrost'
import type { BifrostNodeOptions, GroupPackage, SharePackage } from '@frostr/bifrost'
import { Policy }                   from './policy.js'
import { attach_refusal_replies, cinderella_middleware } from './middleware.js'
import type { MiddlewareLogger }    from './middleware.js'
import { announce_nonce_reset, attach_nonce_reset, attach_responder_resync, ignore_stale_messages } from './resync.js'

export function create_share_node (
  group   : GroupPackage,
  share   : SharePackage,
  relays  : string[],
  policy  : Policy,
  log     : MiddlewareLogger = () => {},
  options : BifrostNodeOptions = {}
) : BifrostNode {
  const node = new BifrostNode(group, share, relays, {
    ...options,
    middleware : { ...options.middleware, sign: cinderella_middleware(policy, log) }
  })
  ignore_stale_messages(node)                       // no answering replayed pings / sign requests after a restart
  attach_responder_resync(node, m => log('info', m))
  attach_nonce_reset(node, m => log('info', m))     // the Gateway restarted: our counts for it are stale too
  attach_refusal_replies(node)
  node.on('ready', () => announce_nonce_reset(node, m => log('info', m)))
  return node
}
