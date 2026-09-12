import type { SqlValue } from '../db/driver.js'

export type ProviderProtocol = 'chat-completions' | 'responses'

export type ProviderCapabilities = {
  streaming: boolean
  functionCalling: boolean
  degraded: boolean
  testedAt: string | null
  error?: string | null
}

export type AiProviderRow = {
  id: string
  name: string
  base_url: string
  api_key: string
  model_id: string
  headers: string | null
  protocol: string
  is_default: number
  capabilities: string | null
  last_tested_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export type AiProvider = {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  modelId: string
  headers: Record<string, string>
  protocol: ProviderProtocol
  isDefault: boolean
  capabilities: ProviderCapabilities | null
  lastTestedAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type PublicAiProvider = Omit<AiProvider, 'apiKey' | 'headers'> & {
  hasApiKey: boolean
  /** Header names remain visible; values are always redacted. */
  headers: Record<string, string>
  headerNames: string[]
}

export type AiProviderInput = {
  name: string
  baseUrl: string
  apiKey?: string
  modelId: string
  headers?: Record<string, string>
  protocol: ProviderProtocol
  isDefault?: boolean
}

export type AiProviderStoreDriver = {
  listRows(): Promise<AiProviderRow[]>
  getRow(id: string): Promise<AiProviderRow | null>
  insertRow(row: AiProviderRow): Promise<void>
  updateRow(id: string, patch: Partial<AiProviderRow>): Promise<boolean>
  deleteRow(id: string): Promise<boolean>
  setDefault(id: string): Promise<boolean>
}

export type AiProviderMutationResult =
  | { ok: true; provider: AiProvider }
  | { ok: false; error: string; code: 'invalid' | 'not_found' | 'storage' }

export type AiProviderProbeResult = {
  ok: boolean
  capabilities: ProviderCapabilities
  error?: string
}

export type SqlProviderArgs = SqlValue[]
