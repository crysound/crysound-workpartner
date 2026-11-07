/** Authenticated, fixed-path guide proxy for the local desktop document. */
import type { PartnerSession } from './partner.ts'

/**
 * Read approved package text without forwarding upstream headers or credentials.
 * @param origin Configured company gateway origin.
 * @param session Current desktop login, read for each request.
 * @param fetcher Main-process HTTP adapter.
 * @returns JSON with no cache, or an empty authentication/upstream error response.
 */
export async function companyGuideResponse(
  origin: string, session: PartnerSession | undefined, fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (session === undefined) return new Response(null, { status: 401 })
  try {
    const response = await fetcher(`${origin}/_zp/market/guides.json`, {
      headers: { authorization: `Bearer ${session.token}` }, redirect: 'error', signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      return new Response(null, { status: response.status })
    }
    return Response.json(await response.json(), { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    // A failed read leaves native plugin settings available; never substitute unauthenticated data.
    return new Response(null, { status: 503 })
  }
}
