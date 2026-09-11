/**
 * Shared HTTP body helper (extracted from app.ts in ticket 06 so the chat
 * routes can reuse the same parse-or-null contract).
 */

/** Parse a JSON request body; null when missing/invalid (caller → 400). */
export async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return null
  }
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}
