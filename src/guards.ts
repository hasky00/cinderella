/**
 * A promise rejection nobody handled means some part of the node failed in a
 * way nothing checked (bifrost, saving state, …). Log it and stop the node
 * (fail-closed): a supervisor (launchd, systemd, Docker) restarts it from its
 * saved state, instead of it signing on in a state nobody checked. Errors are
 * caught where they are expected (e.g. the veto feed's event handler); this
 * only decides what happens to the unexpected ones.
 */

export function install_rejection_guard (log : (level : 'deny', msg : string) => void, exit : (code : number) => void = code => process.exit(code)) : void {
  process.on('unhandledRejection', (reason : unknown) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    log('deny', `unhandled promise rejection, stopping the node: ${msg}`)
    exit(1)
  })
}
