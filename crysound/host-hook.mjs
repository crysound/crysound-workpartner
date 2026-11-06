// Preloaded into the dsh Host (node --import): tells the desktop shell when the company model gateway
// answers 401, so the shell can open the login window again.
const base = process.env.CRYSOUND_LLM_BASE
const original = globalThis.fetch
if (base && original && typeof process.send === 'function') {
  globalThis.fetch = async function (input, init) {
    const response = await original.call(this, input, init)
    if (response.status === 401) {
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.startsWith(base)) process.send({ type: 'crysound-auth-expired' })
      } catch { /* Reporting must not disturb the request. */ }
    }
    return response
  }
}
