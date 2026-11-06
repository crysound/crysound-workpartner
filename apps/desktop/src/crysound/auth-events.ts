/** Bridge from the Host IPC reader to the shell: the gateway rejected the signed-in user's token. */

let listener: (() => void) | undefined

/** @param next - called whenever the Host reports a 401 from the company gateway. */
export function onPartnerAuthExpired(next: () => void): void { listener = next }

/** Called by the Host process reader. */
export function emitPartnerAuthExpired(): void { listener?.() }
