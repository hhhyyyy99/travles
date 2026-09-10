const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

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
 * --strictPort, and waits until /app.html responds. Returns {url, port, close}.
 */
async function startViteApp({ mode } = {}) {
  const appMode = mode || process.env.APP_MODE || 'dev';
  const port = await freePort();
  const host = '127.0.0.1';
  const args =
    appMode === 'preview'
      ? ['preview', '--host', host, '--port', String(port), '--strictPort']
      : ['--host', host, '--port', String(port), '--strictPort'];
  // vite's package.json does not export ./bin/vite.js, so resolve the file directly
  const cli = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => (logs += chunk.toString()));
  child.stderr.on('data', (chunk) => (logs += chunk.toString()));
  let exited = false;
  child.on('exit', () => (exited = true));
  const url = `http://${host}:${port}`;
  try {
    await waitFor(`${url}/app.html`);
  } catch (error) {
    child.kill('SIGTERM');
    throw new Error(`${error.message}\nvite (${appMode}) logs:\n${logs}`);
  }
  return {
    url,
    port,
    close: async () => {
      if (!exited) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    },
  };
}

/**
 * Mirrors the legacy tests/helpers/browser.cjs conventions:
 * - Chromium headless (PLAYWRIGHT_CHROMIUM_EXECUTABLE honoured)
 * - abort every non-127.0.0.1 request
 * - 8s default timeout
 * - optional init script injected before navigation
 * - default entry /app.html; appMode from process.env.APP_MODE (default 'dev')
 */
async function openApp({ mode, init, viewport, entry = '/app.html' } = {}) {
  const server = await startViteApp({ mode });
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    });
    const page = await browser.newPage({ viewport: viewport || { width: 1280, height: 900 } });
    page.setDefaultTimeout(8000);
    await page.route('**/*', (route) =>
      route.request().url().startsWith(server.url) ? route.continue() : route.abort(),
    );
    if (init) await page.addInitScript(init);
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
    await server.close();
    throw error;
  }
}

module.exports = { startViteApp, openApp };
