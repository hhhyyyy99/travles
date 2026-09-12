const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');

const repoRoot = path.resolve(__dirname, '../..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitFor(url, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (res) => {
        res.resume();
        // anything below 5xx means the server is up (dev/preview answer 200)
        if (res.statusCode < 500) return resolve();
        retry();
      });
      request.on('error', retry);
      request.setTimeout(2000, () => {
        request.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${url}`));
      setTimeout(attempt, 150);
    };
    attempt();
  });
}

/**
 * Starts a real Vite server (dev or preview) on 127.0.0.1 with a free port and
 * --strictPort, and waits until the root entry responds. Returns {url, port, close}.
 */
async function startViteApp({ mode, serverPort } = {}) {
  const appMode = mode || process.env.APP_MODE || 'dev';
  const port = await freePort();
  const host = '127.0.0.1';
  const args =
    appMode === 'preview'
      ? ['preview', '--host', host, '--port', String(port), '--strictPort']
      : ['--host', host, '--port', String(port), '--strictPort'];
  // vite's package.json does not export ./bin/vite.js, so resolve the file directly
  const cli = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  // Each server owns its cache: parallel suites must not delete each other's optimizer output.
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'journey-vite-test-'));
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...(serverPort === undefined ? {} : { SERVER_PORT: String(serverPort) }),
      APP_TEST_VITE_CACHE_DIR: cacheDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => (logs += chunk.toString()));
  child.stderr.on('data', (chunk) => (logs += chunk.toString()));
  let exited = false;
  const stopped = new Promise((resolve) => {
    child.once('exit', () => { exited = true; resolve(); });
    child.once('error', () => { exited = true; resolve(); });
  });
  const close = async () => {
    if (!exited) child.kill('SIGTERM');
    await stopped;
    await rm(cacheDir, { recursive: true, force: true });
  };
  const url = `http://${host}:${port}`;
  try {
    await waitFor(`${url}/`);
  } catch (error) {
    await close();
    throw new Error(`${error.message}\nvite (${appMode}) logs:\n${logs}`);
  }
  return {
    url,
    port,
    close,
  };
}

/**
 * Mirrors the legacy tests/helpers/browser.cjs conventions:
 * - Chromium headless (PLAYWRIGHT_CHROMIUM_EXECUTABLE honoured)
 * - abort every non-127.0.0.1 request
 * - 8s default timeout
 * - optional init script injected before navigation
 * - default entry / (ticket 09 cutover; appMode from process.env.APP_MODE (default 'dev'))
 * - `amapConfig404`: force /amap-config.js to 404 (dev serves the gitignored
 *   root file, so the no-config path needs explicit 404 in dev; preview 404s
 *   it naturally)
 * - `setup` (ticket 04): optional async hook `async ({ page, server }) => void`
 *   awaited right BEFORE navigation — the seam API-mock suites use to install
 *   `page.route` handlers (handlers registered before goto() win).
 */
async function openApp({ mode, serverPort, init, viewport, entry = '/', amapConfig404 = false, acceptDownloads = false, setup } = {}) {
  let server;
  let browser;
  try {
    server = await startViteApp({ mode, serverPort });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    });
    const page = await browser.newPage({
      viewport: viewport || { width: 1280, height: 900 },
      // Ticket 07 backup suite exercises real downloads (legacy helper variant)
      acceptDownloads,
    });
    page.setDefaultTimeout(8000);
    await page.route('**/*', (route) =>
      route.request().url().startsWith(server.url) ? route.continue() : route.abort(),
    );
    // Registered after the catch-all: Playwright matches routes LIFO.
    if (amapConfig404) {
      await page.route('**/amap-config.js', (route) => route.fulfill({ status: 404, body: '' }));
    }
    if (init) await page.addInitScript(init);
    if (setup) await setup({ page, server });
    await page.goto(`${server.url}${entry}`);
    return {
      page,
      url: server.url,
      close: async () => {
        await browser.close();
        await server.close();
      },
    };
  } catch (error) {
    await browser?.close();
    // `server` may be unset when startViteApp itself failed — its error
    // (with the vite logs attached) must surface, not a TDZ ReferenceError.
    if (server) await server.close();
    throw error;
  }
}

module.exports = { startViteApp, openApp };
