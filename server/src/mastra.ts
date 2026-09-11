import { Mastra } from '@mastra/core'

/**
 * The single Mastra instance for the backend.
 *
 * Ticket 01 only scaffolds: the instance must be constructible server-side so
 * the HTTP layer can mount it. Agents, memory and storage config land with the
 * later tickets (planner agent / SQLite persistence) — no business features
 * here on purpose.
 */
export const mastra = new Mastra({
  logger: false,
})
