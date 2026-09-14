import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, Check, CircleAlert, CircleHelp, KeyRound, List, Plus, Save, Server, Trash2, WandSparkles } from 'lucide-react'
import {
  createAiProvider,
  deleteAiProvider,
  fetchAiProviders,
  fetchProviderModels,
  fetchSavedProviderModels,
  setDefaultAiProvider,
  testAiProvider,
  testSavedAiProvider,
  updateAiProvider,
  type AiProvider,
  type AiProviderInput,
  type ModelOption,
  type ProviderCapabilities,
  type ProviderProbe,
  type ThinkingLevel,
} from '../domain/aiProviders'

type ProviderForm = {
  name: string
  baseUrl: string
  modelId: string
  protocol: 'chat-completions' | 'responses'
  thinking: ThinkingLevel
  apiKey: string
  headersText: string
  isDefault: boolean
}

const THINKING_OPTIONS: { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

const EMPTY_FORM: ProviderForm = {
  name: '',
  baseUrl: '',
  modelId: '',
  protocol: 'chat-completions',
  thinking: 'off',
  apiKey: '',
  headersText: '',
  isDefault: false,
}

export default function AiSettingsPage({ onBack }: { onBack: () => void }) {
  const [providers, setProviders] = useState<AiProvider[]>([])
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [probe, setProbe] = useState<ProviderProbe | null>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [busy, setBusy] = useState<'save' | 'test' | 'models' | 'default' | 'delete' | null>(null)

  const reload = useCallback(async () => {
    setLoadError(null)
    const result = await fetchAiProviders()
    if (result.ok) setProviders(result.data.providers)
    else setLoadError(result.error)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const beginNew = () => {
    setEditingId(null)
    setForm({ ...EMPTY_FORM, isDefault: providers.length === 0 })
    setProbe(null)
    setModels([])
    setActionError(null)
    setNotice(null)
  }

  const beginEdit = (provider: AiProvider) => {
    setEditingId(provider.id)
    setForm({
      name: provider.name,
      baseUrl: provider.baseUrl,
      modelId: provider.modelId,
      protocol: provider.protocol,
      thinking: provider.thinking,
      // Secret values never come from the public provider payload.
      apiKey: '',
      headersText: '',
      isDefault: provider.isDefault,
    })
    setProbe(provider.capabilities ? { ok: true, capabilities: provider.capabilities } : null)
    setModels([])
    setActionError(null)
    setNotice(`正在编辑「${provider.name}」`)
  }

  const input = useMemo<AiProviderInput>(() => {
    const value: AiProviderInput = {
      name: form.name,
      baseUrl: form.baseUrl,
      modelId: form.modelId,
      protocol: form.protocol,
      thinking: form.thinking,
      isDefault: form.isDefault,
    }
    if (form.apiKey.trim()) value.apiKey = form.apiKey
    if (form.headersText.trim()) {
      try {
        const parsed: unknown = JSON.parse(form.headersText)
        if (isStringRecord(parsed)) value.headers = parsed
      } catch {
        // The save/test action reports the friendlier field error below.
      }
    }
    if (editingId) value.id = editingId
    return value
  }, [editingId, form])

  const validateForm = (): string | null => {
    if (!form.name.trim()) return '请填写配置名称。'
    if (!form.baseUrl.trim()) return '请填写 Base URL。'
    if (!form.modelId.trim()) return '请填写模型 ID。'
    if (!editingId && !form.apiKey.trim()) return '首次保存需要填写 API Key。'
    if (form.headersText.trim()) {
      try {
        if (!isStringRecord(JSON.parse(form.headersText))) return '自定义请求头必须是 JSON 对象，且值为字符串。'
      } catch {
        return '自定义请求头必须是有效的 JSON。'
      }
    }
    return null
  }

  const handleSave = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const validation = validateForm()
    if (validation) {
      setActionError(validation)
      return
    }
    setBusy('save')
    setActionError(null)
    setNotice(null)
    const result = editingId ? await updateAiProvider(editingId, input) : await createAiProvider(input)
    setBusy(null)
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    setProbe(result.data.probe)
    setProviders((current) => {
      const without = current.filter((provider) => provider.id !== result.data.provider.id)
      return [result.data.provider, ...without].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    })
    setEditingId(result.data.provider.id)
    setForm((current) => ({ ...current, apiKey: '', headersText: '', isDefault: result.data.provider.isDefault }))
    setNotice('已保存，连通性与能力探测完成。')
  }

  const handleTest = async () => {
    if (busy) return
    const validation = validateForm()
    if (validation && !(editingId && validation === '首次保存需要填写 API Key。')) {
      setActionError(validation)
      return
    }
    setBusy('test')
    setActionError(null)
    const result = editingId && !form.apiKey.trim() ? await testSavedAiProvider(editingId) : await testAiProvider(input)
    setBusy(null)
    if (!result.ok) {
      setProbe(null)
      setActionError(result.error)
      return
    }
    setProbe(result.data)
    setNotice('连通性测试完成。')
  }

  const handleModels = async () => {
    if (busy) return
    const validation = validateForm()
    if (validation && !(editingId && validation === '首次保存需要填写 API Key。')) {
      setActionError(validation)
      return
    }
    setBusy('models')
    setActionError(null)
    const result = editingId && !form.apiKey.trim() ? await fetchSavedProviderModels(editingId) : await fetchProviderModels(input)
    setBusy(null)
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    setModels(result.data)
    setNotice(result.data.length > 0 ? `找到 ${result.data.length} 个模型，可直接选择或继续手填。` : '服务没有返回可用模型，请继续手填模型 ID。')
  }

  const handleDefault = async (provider: AiProvider) => {
    if (busy || provider.isDefault) return
    setBusy('default')
    setActionError(null)
    const result = await setDefaultAiProvider(provider.id)
    setBusy(null)
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    setProviders((current) => current.map((item) => ({ ...item, isDefault: item.id === provider.id })))
    setNotice(`已切换到「${provider.name}」，下次对话会使用此配置。`)
  }

  const handleDelete = async (provider: AiProvider) => {
    if (busy || !window.confirm(`删除 AI 配置「${provider.name}」？`)) return
    setBusy('delete')
    setActionError(null)
    const result = await deleteAiProvider(provider.id)
    setBusy(null)
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    setProviders((current) => current.filter((item) => item.id !== provider.id))
    if (editingId === provider.id) {
      setEditingId(null)
      setForm({ ...EMPTY_FORM, isDefault: providers.length === 1 })
      setProbe(null)
      setModels([])
    }
    setNotice('已删除 AI 配置。')
  }

  return (
    <div id="ai-settings-page" className="min-h-screen bg-paper text-ink">
      <header className="flex h-[60px] items-center gap-[12px] border-b border-line bg-white px-[4%]">
        <button
          id="ai-settings-back"
          type="button"
          aria-label="返回行程列表"
          title="返回行程列表"
          onClick={onBack}
          className="grid h-[34px] w-[34px] place-items-center rounded-[5px] border border-line text-muted hover:border-green hover:text-green"
        >
          <ArrowLeft aria-hidden="true" className="w-[15px]" />
        </button>
        <div>
          <p className="text-[10px] font-[650] tracking-[0.12em] text-green">DEPLOYMENT</p>
          <h1 className="text-[17px] font-[650]">AI 接入设置</h1>
        </div>
        <div className="ml-auto flex items-center gap-[8px] text-[12px] text-muted">
          <KeyRound aria-hidden="true" className="w-[14px]" />
          密钥仅存服务端
        </div>
      </header>

      <main className="mx-auto grid max-w-[1280px] grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] gap-[22px] px-[4%] py-[28px] max-[850px]:grid-cols-1 max-sm:px-[5%]">
        <section aria-labelledby="ai-provider-list-title">
          <div className="mb-[12px] flex items-end justify-between gap-[12px]">
            <div>
              <p className="eyebrow mb-[5px]">MODEL ROUTING</p>
              <h2 id="ai-provider-list-title" className="text-[22px] font-[600]">模型配置</h2>
            </div>
            <button
              id="ai-provider-new"
              type="button"
              onClick={beginNew}
              className="inline-flex h-[34px] items-center gap-[6px] rounded-[5px] bg-green px-[11px] text-[12px] font-[550] text-white"
            >
              <Plus aria-hidden="true" className="w-[14px]" />
              新建配置
            </button>
          </div>
          <p className="mb-[16px] text-[12px] leading-[1.8] text-muted">每套配置都在服务端完成连通性测试。选中的默认配置会用于新的对话回合，历史上下文按行程保留。</p>
          {loadError && <p className="mb-[12px] border border-red px-[12px] py-[10px] text-[12px] text-red">{loadError}</p>}
          <div id="ai-provider-list" className="flex flex-col gap-[9px]">
            {providers.map((provider) => (
              <article
                key={provider.id}
                data-provider-id={provider.id}
                className={`border bg-white p-[14px] transition-colors ${editingId === provider.id ? 'border-green' : 'border-line'}`}
              >
                <button type="button" className="w-full text-left" onClick={() => beginEdit(provider)}>
                  <div className="flex items-start gap-[10px]">
                    <Server aria-hidden="true" className="mt-[2px] w-[16px] text-green" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-[7px]">
                        <h3 className="truncate text-[14px] font-[600]">{provider.name || '未命名配置'}</h3>
                        {provider.isDefault && <span className="inline-flex items-center gap-[4px] rounded-[999px] bg-[#e9f0eb] px-[7px] py-[2px] text-[10px] text-green"><Check aria-hidden="true" className="w-[11px]" />默认</span>}
                      </div>
                      <p className="mt-[4px] truncate text-[11px] text-muted">{provider.modelId || '未填写模型'} · {provider.protocol === 'responses' ? 'Responses' : 'Chat Completions'}</p>
                    </div>
                  </div>
                </button>
                <div className="mt-[11px] flex items-center gap-[8px] border-t border-line pt-[9px] text-[11px] text-muted">
                  <span>{provider.hasApiKey ? 'API Key 已保存' : '未配置 API Key'}</span>
                  <span className="ml-auto">{provider.headerNames.length > 0 ? `${provider.headerNames.length} 个自定义请求头` : '无自定义请求头'}</span>
                  <button type="button" disabled={provider.isDefault || busy !== null} onClick={() => void handleDefault(provider)} className="text-green disabled:text-muted">设为默认</button>
                  <button type="button" aria-label={`删除 ${provider.name}`} disabled={busy !== null} onClick={() => void handleDelete(provider)} className="text-muted hover:text-red disabled:opacity-40"><Trash2 aria-hidden="true" className="w-[14px]" /></button>
                </div>
              </article>
            ))}
            {providers.length === 0 && !loadError && <div className="border border-dashed border-line bg-white px-[16px] py-[28px] text-center text-[12px] text-muted">还没有 AI 配置。</div>}
          </div>
        </section>

        <section className="border border-line bg-white p-[20px] max-sm:p-[16px]" aria-labelledby="ai-provider-form-title">
          <div className="flex items-start gap-[10px] border-b border-line pb-[13px]">
            <WandSparkles aria-hidden="true" className="mt-[2px] w-[17px] text-green" />
            <div>
              <h2 id="ai-provider-form-title" className="text-[18px] font-[600]">{editingId ? '编辑 AI 配置' : '新建 AI 配置'}</h2>
              <p className="mt-[3px] text-[11px] text-muted">支持 Chat Completions 与 Responses 两种协议格式。</p>
            </div>
          </div>
          <form id="ai-provider-form" className="mt-[18px] flex flex-col gap-[14px]" onSubmit={(event) => void handleSave(event)}>
            <div className="grid grid-cols-2 gap-[12px] max-[560px]:grid-cols-1">
              <Field label="配置名称" htmlFor="ai-provider-name"><input id="ai-provider-name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="例如：公司模型网关" maxLength={100} /></Field>
              <Field label="模型 ID" htmlFor="ai-provider-model"><input id="ai-provider-model" list="ai-provider-model-options" value={form.modelId} onChange={(event) => setForm((current) => ({ ...current, modelId: event.target.value }))} placeholder="例如：gpt-4o-mini" /><datalist id="ai-provider-model-options">{models.map((model) => <option key={model.id} value={model.id} />)}</datalist></Field>
            </div>
            <Field label="Base URL" htmlFor="ai-provider-base-url"><input id="ai-provider-base-url" type="url" value={form.baseUrl} onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" /></Field>
            <fieldset>
              <legend className="mb-[6px] text-[12px] text-muted">协议格式</legend>
              <div className="grid grid-cols-2 gap-[8px]">
                <ProtocolOption id="ai-provider-protocol-chat-completions" checked={form.protocol === 'chat-completions'} onChange={() => setForm((current) => ({ ...current, protocol: 'chat-completions' }))} label="Chat Completions" />
                <ProtocolOption id="ai-provider-protocol-responses" checked={form.protocol === 'responses'} onChange={() => setForm((current) => ({ ...current, protocol: 'responses' }))} label="Responses" />
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-[6px] text-[12px] text-muted">思考档位</legend>
              <div className="grid grid-cols-4 gap-[8px]">
                {THINKING_OPTIONS.map((option) => (
                  <ProtocolOption
                    key={option.value}
                    id={`ai-provider-thinking-${option.value}`}
                    checked={form.thinking === option.value}
                    onChange={() => setForm((current) => ({ ...current, thinking: option.value }))}
                    label={option.label}
                  />
                ))}
              </div>
            </fieldset>
            <Field label="API Key" htmlFor="ai-provider-key" hint={editingId ? '留空表示沿用服务端已保存的密钥' : '首次保存必填；密钥不会返回浏览器'}><input id="ai-provider-key" type="password" autoComplete="new-password" value={form.apiKey} onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))} placeholder={editingId ? '已保存，输入新值可替换' : '输入服务商 API Key'} /></Field>
            <Field label="自定义请求头" htmlFor="ai-provider-headers" hint={editingId ? '留空表示沿用已保存请求头；值只存服务端' : 'JSON 对象，例如 {"X-Workspace":"travel"}'}><textarea id="ai-provider-headers" rows={4} value={form.headersText} onChange={(event) => setForm((current) => ({ ...current, headersText: event.target.value }))} placeholder={'{"X-Workspace":"travel"}'} /></Field>
            <label className="flex cursor-pointer items-center gap-[8px] text-[12px] text-muted"><input id="ai-provider-default" type="checkbox" checked={form.isDefault} onChange={(event) => setForm((current) => ({ ...current, isDefault: event.target.checked }))} />保存后设为默认配置</label>

            {(actionError || notice) && <div role={actionError ? 'alert' : 'status'} className={`flex items-start gap-[7px] border px-[11px] py-[9px] text-[12px] leading-[1.7] ${actionError ? 'border-red text-red' : 'border-line text-green'}`}>{actionError ? <CircleAlert aria-hidden="true" className="mt-[3px] w-[14px]" /> : <Check aria-hidden="true" className="mt-[3px] w-[14px]" />}<span>{actionError ?? notice}</span></div>}
            {probe && <CapabilityStatus capabilities={probe.capabilities} ok={probe.ok} />}

            <div className="flex flex-wrap gap-[8px] border-t border-line pt-[14px]">
              <button id="ai-provider-save" type="submit" disabled={busy !== null} className="inline-flex h-[36px] items-center gap-[6px] rounded-[5px] bg-green px-[13px] text-[12px] font-[550] text-white disabled:opacity-50"><Save aria-hidden="true" className="w-[14px]" />{busy === 'save' ? '保存中…' : '保存并检测'}</button>
              <button id="ai-provider-test" type="button" disabled={busy !== null} onClick={() => void handleTest()} className="inline-flex h-[36px] items-center gap-[6px] rounded-[5px] border border-line px-[12px] text-[12px] text-muted hover:border-green hover:text-green disabled:opacity-50"><CircleHelp aria-hidden="true" className="w-[14px]" />{busy === 'test' ? '测试中…' : '测试连通性'}</button>
              <button id="ai-provider-models" type="button" disabled={busy !== null} onClick={() => void handleModels()} className="inline-flex h-[36px] items-center gap-[6px] rounded-[5px] border border-line px-[12px] text-[12px] text-muted hover:border-green hover:text-green disabled:opacity-50"><List aria-hidden="true" className="w-[14px]" />{busy === 'models' ? '获取中…' : '获取模型列表'}</button>
            </div>
          </form>
        </section>
      </main>
    </div>
  )
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return <label htmlFor={htmlFor} className="block text-[12px] text-muted">{label}{hint && <span className="ml-[6px] text-[10px] text-muted/80">{hint}</span>}<span className="mt-[6px] block [&_input]:h-[38px] [&_input]:w-full [&_input]:rounded-[5px] [&_input]:border [&_input]:border-line [&_input]:bg-paper [&_input]:px-[10px] [&_input]:text-[13px] [&_input]:text-ink [&_input]:outline-none [&_input]:focus:border-green [&_textarea]:w-full [&_textarea]:resize-y [&_textarea]:rounded-[5px] [&_textarea]:border [&_textarea]:border-line [&_textarea]:bg-paper [&_textarea]:p-[10px] [&_textarea]:font-mono [&_textarea]:text-[12px] [&_textarea]:text-ink [&_textarea]:outline-none [&_textarea]:focus:border-green">{children}</span></label>
}

function ProtocolOption({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: () => void; label: string }) {
  return <label className={`flex h-[38px] cursor-pointer items-center gap-[7px] rounded-[5px] border px-[10px] text-[12px] ${checked ? 'border-green bg-[#e9f0eb] text-green' : 'border-line text-muted'}`}><input id={id} type="radio" name="ai-provider-protocol" checked={checked} onChange={onChange} />{label}</label>
}

function CapabilityStatus({ capabilities, ok }: { capabilities: ProviderCapabilities; ok: boolean }) {
  const lines = [
    capabilities.streaming ? '流式输出可用' : '流式输出不可用，将由服务端完整读取',
    capabilities.functionCalling ? 'Function calling 可用' : 'Function calling 不可用，已降级为约定 JSON 文本解析',
  ]
  return <div data-capability-status className={`border px-[11px] py-[10px] text-[12px] ${ok ? 'border-line text-muted' : 'border-red text-red'}`}><div className="flex items-center gap-[6px] font-[550]">{ok ? <Check aria-hidden="true" className="w-[14px] text-green" /> : <CircleAlert aria-hidden="true" className="w-[14px]" />}能力探测{ok ? '完成' : '失败'}</div><ul className="mt-[5px] flex flex-col gap-[2px] pl-[20px]">{lines.map((line) => <li key={line}>{line}</li>)}</ul>{capabilities.error && <p className="mt-[5px] text-[11px]">{capabilities.error}</p>}</div>
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === 'string')
}
