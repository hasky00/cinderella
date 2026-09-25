/**
 * Build a Cinderella share node: a bifrost signer with the policy middleware
 * and nonce resync attached. Used by node.ts and the tests, so both run the
 * exact same wiring.
 */

import { BifrostNode }              from '@frostr/bifrost'
import type { BifrostNodeOptions, GroupPackage, SharePackage } from '@frostr/bifrost'
import { Policy }                   from './policy.js'
import { cinderella_middleware }    from './middleware.js'
import type { MiddlewareLogger }    from './middleware.js'
import { attach_responder_resync }  from './resync.js'

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
  attach_responder_resync(node, m => log('info', m))
  return node
}
