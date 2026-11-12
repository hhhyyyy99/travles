import type { ProviderProtocol } from './aiProviders'

export type AiProviderTemplate = {
  id: string
  name: string
  baseUrl: string
  modelId: string
  protocol: ProviderProtocol
  guidance: string
  documentationUrl: string
}

/** Public connection defaults, checked against official docs on 2026-11-12.
 * Credentials are deliberately absent. These are editable starting points;
 * the existing server-side probe still determines account/model capabilities.
 */
export const AI_PROVIDER_TEMPLATES: readonly AiProviderTemplate[] = [
  {
    id: 'deepseek', name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-flash', protocol: 'chat-completions',
    guidance: '使用 DeepSeek 官方兼容接口；可按账号支持的模型修改模型 ID。',
    documentationUrl: 'https://api-docs.deepseek.com/',
  },
  {
    id: 'qwen', name: 'Qwen（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen-plus', protocol: 'chat-completions',
    guidance: '默认使用百炼中国内地入口；其他地域或工作空间请按账号文档修改地址。',
    documentationUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
  },
  {
    id: 'kimi', name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1', modelId: 'kimi-k3.1-pro', protocol: 'chat-completions',
    guidance: '使用 Kimi 中国内地兼容接口；模型始终启用思考，可选低或高档位，默认表示沿用模型行为。',
    documentationUrl: 'https://platform.kimi.com/docs/get-api-key',
  },
  {
    id: 'siliconflow', name: 'SiliconFlow（硅基流动）',
    baseUrl: 'https://api.siliconflow.cn/v1', modelId: 'deepseek-ai/DeepSeek-V4-Flash', protocol: 'chat-completions',
    guidance: '使用硅基流动中国站；可获取模型列表，选择账号有权访问的模型。',
    documentationUrl: 'https://docs.siliconflow.cn/docs/userguide/quickstart',
  },
  {
    id: 'openai', name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-5.4-mini', protocol: 'chat-completions',
    guidance: '使用 OpenAI 官方接口，也可按需要切换为 Responses 协议。',
    documentationUrl: 'https://developers.openai.com/api/docs/models/gpt-5.4-mini',
  },
  {
    id: 'claude', name: 'Claude',
    baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-sonnet-4-6', protocol: 'chat-completions',
    guidance: '使用官方 OpenAI 兼容接口；未绑定工作区的密钥需添加 anthropic-workspace-id 请求头。部分原生能力不可用。',
    documentationUrl: 'https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk',
  },
  {
    id: 'gemini', name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', modelId: 'gemini-3.8-flash', protocol: 'chat-completions',
    guidance: '使用 Gemini 的 OpenAI 兼容接口，需提供 Google AI Studio API Key。',
    documentationUrl: 'https://ai.google.dev/gemini-api/docs/openai',
  },
]
