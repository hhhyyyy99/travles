import assert from 'node:assert/strict'
import type { LookupAddress } from 'node:dns'
import { createServer, request } from 'node:http'
import type { RequestListener, RequestOptions } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { loadGuideSource } from '../src/guide-parsing/source.js'
import type { GuideSourceDependencies, GuideSourceResult } from '../src/guide-parsing/source.js'

const PUBLIC_ADDRESS = { address: '93.184.216.34', family: 4 }
const GUIDANCE = '暂时无法读取该链接，请复制攻略正文并粘贴到输入框后重试。'

function assertUnavailable(result: GuideSourceResult): void {
  assert.deepEqual(result, { status: 'text_required', code: 'source_unavailable', guidance: GUIDANCE })
}

/** Only this injected transport reaches the local fixture; public DNS is never used. */
async function fixture(t: TestContext, handler: RequestListener) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })
  const requests: string[] = []
  const resolved: string[] = []
  const pins: LookupAddress[][] = []
  const deps: GuideSourceDependencies = {
    resolve: async (hostname) => {
      resolved.push(hostname)
      return [PUBLIC_ADDRESS]
    },
    request: (url, options, onResponse) => {
      requests.push(url.href)
      assert.equal(options.agent, false)
      assert.equal(options.method, 'GET')
      assert.ok(options.signal)
      assert.ok(options.lookup)
      const localLookup: NonNullable<RequestOptions['lookup']> = (_hostname, lookupOptions, callback) => {
        options.lookup!(url.hostname, lookupOptions, (error, pinned, family) => {
          assert.ifError(error)
          pins.push(Array.isArray(pinned) ? pinned : [{ address: pinned, family: family! }])
          // Preserve the real request/stream lifecycle, but route exclusively to loopback.
          if (lookupOptions.all) callback(null, [{ address: '127.0.0.1', family: 4 }])
          else callback(null, '127.0.0.1', 4)
        })
      }
      return request({
        ...options,
        hostname: 'fixture.example.test',
        protocol: 'http:',
        port: address.port,
        path: url.pathname + url.search,
        lookup: localLookup,
      }, onResponse)
    },
  }
  return { deps, requests, resolved, pins }
}

test('pasted text takes priority, preserves paragraphs, and never touches DNS or HTTP', async () => {
  const result = await loadGuideSource({ text: '  第一天游览古城。\n\n第二天去湖边。  ', url: 'http://127.0.0.1/private' }, {
    resolve: async () => { assert.fail('text must bypass DNS') },
    request: () => { assert.fail('text must bypass HTTP') },
  })
  assert.deepEqual(result, { status: 'ready', text: '第一天游览古城。\n\n第二天去湖边。', source: { kind: 'text' } })
  assert.equal((await loadGuideSource({ text: '文'.repeat(20_000) })).status, 'ready')
  assertUnavailable(await loadGuideSource({ text: '文'.repeat(20_001), url: 'https://guide.example/' }))
  assertUnavailable(await loadGuideSource({ text: '  ' }))
})

test('HTML extraction keeps article paragraphs and removes surrounding or hidden content', async (t) => {
  const { deps, pins, requests } = await fixture(t, (req, res) => {
    assert.equal(req.headers['accept-encoding'], 'identity')
    res.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' })
    res.end(`<!doctype html><html><head><title>海拉尔攻略</title><style>secret style</style></head>
      <body><header>网站标题</header><nav>导航</nav><main><p>正文外的介绍</p><article>
      <h1>海拉尔攻略</h1><p>第一天先去<strong>呼伦湖</strong>，再去古城。</p>
      <p>第二天看草原 &amp; 日落。</p><script>secret script</script><aside>广告</aside>
      <p hidden>隐藏内容</p><p style="display: none">更多广告</p></article></main><footer>页脚</footer></body></html>`)
  })
  assert.deepEqual(await loadGuideSource({ url: 'https://guide.example/trip#intro' }, deps), {
    status: 'ready', text: '海拉尔攻略\n\n第一天先去呼伦湖，再去古城。\n\n第二天看草原 & 日落。',
    source: { kind: 'url', url: 'https://guide.example/trip' },
  })
  assert.deepEqual(pins, [[PUBLIC_ADDRESS]])
  assert.deepEqual(requests, ['https://guide.example/trip'])
})

test('plain text and main/body HTML fallbacks retain readable paragraph boundaries', async (t) => {
  const { deps } = await fixture(t, (req, res) => {
    if (req.url === '/plain') {
      res.writeHead(200, { 'content-type': 'text/plain; charset="utf-8"', 'content-encoding': 'identity' })
      res.end('第一天：古城。\r\n\r\n第二天：湖边。')
    } else {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(req.url === '/main'
        ? '<html><body><nav>菜单</nav><main><p>第一天：古城。</p><p>第二天：湖边。</p></main></body></html>'
        : '<html><body><p>第一天：古城。</p><p>第二天：湖边。</p><footer>页脚</footer></body></html>')
    }
  })
  for (const path of ['/plain', '/main', '/body']) {
    const result = await loadGuideSource({ url: `http://guide.example${path}` }, deps)
    assert.equal(result.status, 'ready')
    if (result.status === 'ready') assert.equal(result.text, '第一天：古城。\n\n第二天：湖边。')
  }
})

test('redirects revalidate and resolve every hop, then return the final safe URL', async (t) => {
  const { deps, resolved, requests, pins } = await fixture(t, (req, res) => {
    if (req.url === '/start') res.writeHead(302, { location: 'https://other.example/next#part' }).end()
    else if (req.url === '/next') res.writeHead(307, { location: '/final?q=lake' }).end()
    else res.writeHead(200, { 'content-type': 'text/plain' }).end('先去古城，再去湖边。')
  })
  assert.deepEqual(await loadGuideSource({ url: 'http://guide.example/start' }, deps), {
    status: 'ready', text: '先去古城，再去湖边。', source: { kind: 'url', url: 'https://other.example/final?q=lake' },
  })
  assert.deepEqual(resolved, ['guide.example', 'other.example', 'other.example'])
  assert.equal(requests.length, 3)
  assert.deepEqual(pins, [[PUBLIC_ADDRESS], [PUBLIC_ADDRESS], [PUBLIC_ADDRESS]])
})

test('invalid schemes, credentials, ports, local names, and nonpublic literals never reach transport', async () => {
  const urls = [
    'file:///etc/hosts', 'ftp://guide.example/', 'https://reader:pw@guide.example/', 'https://:pw@guide.example/',
    'http://guide.example:8080/', 'https://guide.example:444/',
    'http://localhost/', 'http://localhost./', 'http://reader.local/', 'http://intranet/',
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/',
    'http://0.0.0.0/', 'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.1.1/',
    'http://169.254.169.254/', 'http://100.64.0.1/', 'http://224.0.0.1/',
    'http://[::]/', 'http://[::1]/', 'http://[fc00::1]/', 'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.0.0.1]/', 'http://[::127.0.0.1]/',
    'http://[64:ff9b::a00:1]/', 'http://[2002:0a00:0001::]/',
  ]
  let dnsCalls = 0
  let httpCalls = 0
  const deps: GuideSourceDependencies = {
    resolve: async () => { dnsCalls += 1; return [PUBLIC_ADDRESS] },
    request: () => { httpCalls += 1; throw new Error('Unexpected request') },
  }
  for (const url of urls) assertUnavailable(await loadGuideSource({ url }, deps))
  assert.equal(dnsCalls, 0)
  assert.equal(httpCalls, 0)
})

test('all DNS answers must be public, including IPv6 and mapped addresses', async () => {
  const badAnswers: LookupAddress[][] = [
    [], [{ address: '127.0.0.1', family: 4 }], [PUBLIC_ADDRESS, { address: '10.1.2.3', family: 4 }],
    [PUBLIC_ADDRESS, { address: 'fe80::1', family: 6 }], [{ address: '::ffff:192.168.1.1', family: 6 }],
    [{ address: '::1', family: 6 }], [{ address: 'not-an-ip', family: 4 }],
    [{ address: PUBLIC_ADDRESS.address, family: 6 }],
  ]
  let httpCalls = 0
  const unexpectedRequest = () => { httpCalls += 1; throw new Error('Unexpected request') }
  for (const answers of badAnswers) {
    assertUnavailable(await loadGuideSource({ url: 'https://guide.example/' }, {
      resolve: async () => answers,
      request: unexpectedRequest,
    }))
  }
  assertUnavailable(await loadGuideSource({ url: 'https://guide.example/' }, {
    resolve: async () => { throw new Error('raw internal DNS secret') },
    request: unexpectedRequest,
  }))
  assert.equal(httpCalls, 0)
})

test('public IPv6 is pinned without a second resolver call', async (t) => {
  const { deps, pins, resolved } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('古城和湖边的游览攻略。')
  })
  const publicIpv6 = { address: '2606:4700:4700::1111', family: 6 }
  const result = await loadGuideSource({ url: 'https://guide.example/' }, { ...deps, resolve: async () => [publicIpv6] })
  assert.equal(result.status, 'ready')
  assert.deepEqual(pins, [[publicIpv6]])
  assert.deepEqual(resolved, [])
})

test('private, credentialed, and nonpublic DNS redirect targets are blocked before another request', async (t) => {
  const { deps, requests } = await fixture(t, (req, res) => {
    const locations: Record<string, string> = {
      '/private': 'http://127.0.0.1/secret', '/mapped': 'http://[::ffff:169.254.169.254]/',
      '/credentials': 'https://reader:pw@other.example/', '/dns': 'https://internal.example/',
      '/port': 'http://other.example:8080/', '/scheme': 'file:///etc/hosts',
    }
    res.writeHead(302, { location: locations[req.url ?? ''] ?? '/' }).end()
  })
  const secureDeps = { ...deps, resolve: async (hostname: string) =>
    hostname === 'internal.example' ? [{ address: '10.0.0.1', family: 4 }] : [PUBLIC_ADDRESS] }
  for (const path of ['/private', '/mapped', '/credentials', '/dns', '/port', '/scheme']) {
    const before = requests.length
    assertUnavailable(await loadGuideSource({ url: `https://guide.example${path}` }, secureDeps))
    assert.equal(requests.length, before + 1)
  }
})

test('DNS is checked again on redirects to the same hostname and redirects stop after three', async (t) => {
  const { deps, requests } = await fixture(t, (_req, res) => {
    res.writeHead(302, { location: '/again' }).end()
  })
  let lookups = 0
  assertUnavailable(await loadGuideSource({ url: 'http://guide.example/' }, {
    ...deps,
    resolve: async () => ++lookups === 1 ? [PUBLIC_ADDRESS] : [{ address: '127.0.0.1', family: 4 }],
  }))
  assert.equal(requests.length, 1)
  requests.length = 0
  assertUnavailable(await loadGuideSource({ url: 'http://guide.example/' }, deps))
  assert.equal(requests.length, 4)
})

test('one total deadline bounds stalled DNS, headers, and body', async (t) => {
  const { deps } = await fixture(t, (req, res) => {
    if (req.url === '/body') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('正文尚未传输完毕。')
    }
    // /headers intentionally sends no headers.
  })
  const started = performance.now()
  assertUnavailable(await loadGuideSource({ url: 'https://guide.example/' }, {
    ...deps, timeoutMs: 40, resolve: () => new Promise(() => {}),
  }))
  for (const path of ['/headers', '/body']) {
    assertUnavailable(await loadGuideSource({ url: `https://guide.example${path}` }, { ...deps, timeoutMs: 40 }))
  }
  assert.ok(performance.now() - started < 1500, 'timeouts must settle without waiting for network completion')
})

test('the deadline is shared by DNS, redirects, and streaming rather than restarting per hop', async (t) => {
  const { deps, requests } = await fixture(t, async (req, res) => {
    await delay(40)
    if (req.url === '/start') res.writeHead(302, { location: '/final' }).end()
    else res.writeHead(200, { 'content-type': 'text/plain' }).end('湖边游览攻略。')
  })
  assertUnavailable(await loadGuideSource({ url: 'https://guide.example/start' }, {
    ...deps, timeoutMs: 100,
    resolve: async () => { await delay(25); return [PUBLIC_ADDRESS] },
  }))
  assert.ok(requests.length <= 2)
})

test('content-length, streamed bytes, and extracted text are bounded without truncation', async (t) => {
  const { deps } = await fixture(t, (req, res) => {
    res.setHeader('content-type', 'text/plain')
    if (req.url === '/length') {
      res.writeHead(200, { 'content-length': 1024 * 1024 + 1 })
      res.flushHeaders()
    } else if (req.url === '/stream') {
      res.writeHead(200)
      for (let i = 0; i < 17; i += 1) res.write(Buffer.alloc(64 * 1024, 97))
      res.end()
    } else if (req.url === '/article') res.end('文'.repeat(20_001))
    else if (req.url === '/html') {
      res.setHeader('content-type', 'text/html')
      res.end(`<html><body><article><p>${'文'.repeat(20_001)}</p></article></body></html>`)
    } else res.end('文'.repeat(20_000))
  })
  for (const path of ['/length', '/stream', '/article', '/html']) {
    assertUnavailable(await loadGuideSource({ url: `https://guide.example${path}` }, deps))
  }
  const exact = await loadGuideSource({ url: 'https://guide.example/exact' }, deps)
  assert.equal(exact.status, 'ready')
  if (exact.status === 'ready') assert.equal(exact.text.length, 20_000)
})

test('403, challenges, login, empty pages, compressed or unexpected content use fixed paste guidance', async (t) => {
  const { deps } = await fixture(t, (req, res) => {
    const pages: Record<string, { status?: number; type?: string; encoding?: string; body: string }> = {
      '/403': { status: 403, body: 'raw server diagnostics' },
      '/captcha': { body: '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>' },
      '/challenge': { body: '<html><body><main>请完成人机验证后继续查看攻略。</main></body></html>' },
      '/login': { body: '<html><head><title>登录</title></head><body><form>请输入账号</form></body></html>' },
      '/empty': { body: '<html><body><nav>菜单</nav><script>client render only</script></body></html>' },
      '/compressed': { encoding: 'gzip', body: 'pretend compressed bytes' },
      '/binary': { type: 'application/octet-stream', body: 'binary' },
      '/missing-type': { type: '', body: 'untyped response' },
      '/invalid-utf8': { type: 'text/plain', body: '\u0000' },
    }
    const page = pages[req.url ?? '']!
    if (page.type !== '') res.setHeader('content-type', page.type ?? 'text/html')
    if (page.encoding) res.setHeader('content-encoding', page.encoding)
    res.writeHead(page.status ?? 200).end(page.body)
  })
  for (const path of ['/403', '/captcha', '/challenge', '/login', '/empty', '/compressed', '/binary', '/missing-type', '/invalid-utf8']) {
    assertUnavailable(await loadGuideSource({ url: `https://guide.example${path}` }, deps))
  }
  assertUnavailable(await loadGuideSource({ url: 'https://guide.example/' }, {
    resolve: async () => [PUBLIC_ADDRESS], request: () => { throw new Error('private transport credentials') },
  }))
})
