/**
 * Last line of defence for a long-running share node: a promise rejection
 * nobody handled is logged instead of crashing the process (Node's default
 * since v15). Errors should still be caught where they happen; this only
 * keeps one missed case from taking the node down.
 */

export function install_rejection_guard (log : (level : 'deny', msg : string) => void) : void {
  process.on('unhandledRejection', (reason : unknown) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    log('deny', `unhandled promise rejection (node keeps running): ${msg}`)
  })
}
