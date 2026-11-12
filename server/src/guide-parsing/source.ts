import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { request as httpRequest } from 'node:http'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { parseHTML } from 'linkedom'

export type GuideSourceResult =
  | { status: 'ready'; text: string; source: { kind: 'text' | 'url'; url?: string } }
  | { status: 'text_required'; code: 'source_unavailable'; guidance: string }

export interface GuideSourceDependencies {
  resolve?: (hostname: string) => Promise<readonly LookupAddress[]>
  /** Node transport seam; implementations must use the supplied pinned lookup. */
  request?: (url: URL, options: RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest
  /** Tests may shorten, but never extend, the total ten-second deadline. */
  timeoutMs?: number
}

const MAX_TEXT = 20_000
const MAX_BYTES = 1024 * 1024
const MAX_REDIRECTS = 3
const TIMEOUT_MS = 10_000
const GUIDANCE = '暂时无法读取该链接，请复制攻略正文并粘贴到输入框后重试。'
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const CHALLENGE = /captcha|verify (?:that )?you are (?:a )?human|checking (?:your )?browser|just a moment|access denied|enable javascript(?: and cookies)?|(?:请|需要|必须|先).{0,12}(?:登录|登陆)|(?:请完成|安全|人机|滑动|滑块)验证|登录后(?:查看|阅读)|登录以继续|sign in to (?:continue|read)|log in to (?:continue|read)/i

function unavailable(): GuideSourceResult {
  return { status: 'text_required', code: 'source_unavailable', guidance: GUIDANCE }
}

/** Load pasted text or a bounded public article; never expose transport errors. */
export async function loadGuideSource(
  input: { text?: string; url?: string },
  deps: GuideSourceDependencies = {},
): Promise<GuideSourceResult> {
  const pasted = input.text?.trim()
  if (pasted) {
    return pasted.length <= MAX_TEXT
      ? { status: 'ready', text: pasted, source: { kind: 'text' } }
      : unavailable()
  }
  if (!input.url) return unavailable()

  const controller = new AbortController()
  const duration = Math.min(TIMEOUT_MS, Math.max(1, deps.timeoutMs ?? TIMEOUT_MS))
  const deadline = performance.now() + duration
  const timer = setTimeout(() => controller.abort(), duration)
  try {
    let url = new URL(input.url)
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const hostname = validateUrl(url)
      const family = isIP(hostname)
      const addresses = family
        ? [{ address: hostname, family }]
        : await beforeAbort(
          (deps.resolve ?? ((host) => lookup(host, { all: true, verbatim: true })))(hostname),
          controller.signal,
        )
      if (!addresses.length || addresses.some(({ address, family: resolvedFamily }) =>
        !isPublicAddress(address) || isIP(address) !== resolvedFamily)) throw new Error('Unavailable')
      controller.signal.throwIfAborted()
      if (performance.now() >= deadline) throw new Error('Unavailable')

      const response = await readResponse(url, addresses, controller.signal, deps.request)
      if ('location' in response) {
        if (redirects === MAX_REDIRECTS) throw new Error('Unavailable')
        url = new URL(response.location, url)
        continue
      }
      const charset = /;\s*charset\s*=\s*["']?([^\s;"']+)/i.exec(response.contentType)?.[1] ?? 'utf-8'
      const body = new TextDecoder(charset, { fatal: true }).decode(response.body)
      const text = response.contentType.split(';', 1)[0]?.trim().toLowerCase() === 'text/plain'
        ? cleanText(body)
        : articleText(body)
      if (!text || text.length > MAX_TEXT || text.includes('\u0000') || CHALLENGE.test(text.slice(0, 1000))
        || performance.now() >= deadline) return unavailable()
      return { status: 'ready', text, source: { kind: 'url', url: url.href } }
    }
  } catch {
    return unavailable()
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  return unavailable()
}

function validateUrl(url: URL): string {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || (url.port && !['80', '443'].includes(url.port))) throw new Error('Unavailable')
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!hostname || (!isIP(hostname) && (!hostname.includes('.')
    || /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home)$/.test(hostname)))) throw new Error('Unavailable')
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new Error('Unavailable')
  url.hash = ''
  return hostname
}

function isPublicAddress(address: string): boolean {
  if (!isIP(address)) return false
  const parsed = ipaddr.process(address)
  // Restrict native IPv6 to global unicast; process also checks mapped IPv4.
  return parsed.range() === 'unicast'
    && (parsed.kind() === 'ipv4' || parsed.match(ipaddr.parseCIDR('2000::/3')))
}

function beforeAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Unavailable'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

type SourceResponse = { location: string } | { body: Buffer; contentType: string }

function readResponse(
  url: URL,
  addresses: readonly LookupAddress[],
  signal: AbortSignal,
  transport: GuideSourceDependencies['request'] = (target, options, onResponse) =>
    (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, options, onResponse),
): Promise<SourceResponse> {
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined
    let response: IncomingMessage | undefined
    let settled = false
    const finish = (value?: SourceResponse) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      if (value) resolve(value)
      else reject(new Error('Unavailable'))
      response?.destroy()
      request?.destroy()
    }
    const abort = () => finish()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) return finish()
    const pinnedLookup: NonNullable<RequestOptions['lookup']> = (_hostname, options, callback) => {
      const address = addresses[0]!
      if (options.all) callback(null, [...addresses])
      else callback(null, address.address, address.family)
    }
    try {
      request = transport(url, {
        method: 'GET',
        agent: false,
        lookup: pinnedLookup,
        signal,
        maxHeaderSize: 16 * 1024,
        headers: {
          accept: 'text/html, text/plain;q=0.9',
          'accept-encoding': 'identity',
          'user-agent': 'TripGuideSource/1.0',
        },
      }, (incoming) => {
        response = incoming
        incoming.on('error', abort)
        incoming.on('aborted', abort)
        if (settled) return incoming.destroy()
        const status = incoming.statusCode ?? 0
        if (REDIRECTS.has(status)) {
          const location = incoming.headers.location
          return location ? finish({ location }) : finish()
        }
        const contentType = incoming.headers['content-type'] ?? ''
        const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase()
        const encoding = incoming.headers['content-encoding']?.trim().toLowerCase()
        const length = incoming.headers['content-length']
        if (status < 200 || status >= 300
          || !['text/html', 'application/xhtml+xml', 'text/plain'].includes(mediaType ?? '')
          || (encoding && encoding !== 'identity')
          || (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))) return finish()
        const chunks: Buffer[] = []
        let bytes = 0
        incoming.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > MAX_BYTES) return finish()
          chunks.push(chunk)
        })
        incoming.on('end', () => {
          if (!incoming.complete) return finish()
          finish({ body: Buffer.concat(chunks, bytes), contentType })
        })
        incoming.on('close', () => { if (!incoming.complete) finish() })
      })
      request.on('error', abort)
      request.end()
    } catch {
      finish()
    }
  })
}

function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\t\f\v \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function articleText(html: string): string {
  const { document } = parseHTML(html)
  const title = document.querySelector('title')?.textContent ?? ''
  if (CHALLENGE.test(title) || /^(?:登录|登陆|用户登录|login|log in|sign in)(?:\s*[-|·].*)?$/i.test(title.trim())
    || document.querySelector('input[type="pass\u0077ord"], [id*="captcha"], [class*="captcha"], [id^="cf-chl"], iframe[src*="captcha"]')) return ''
  for (const element of document.querySelectorAll(
    'script, style, noscript, template, nav, header, footer, aside, form, button, input, select, textarea, svg, canvas, iframe, head, [hidden], [aria-hidden="true"], [role="navigation"], [role="banner"], [role="contentinfo"]',
  )) element.remove()
  for (const element of document.querySelectorAll('[style]')) {
    if (/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(element.getAttribute('style') ?? '')) element.remove()
  }
  const article = document.querySelector('article') ?? document.querySelector('main, [role="main"]') ?? document.body
  for (const block of article.querySelectorAll('p, div, section, h1, h2, h3, h4, h5, h6, li, blockquote, pre, tr, br, hr')) {
    block.before(document.createTextNode('\n\n'))
    block.after(document.createTextNode('\n\n'))
  }
  return cleanText(article.textContent ?? '')
}
