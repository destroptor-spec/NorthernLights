// Optional integration test: requires separately installed Playwright/Chromium.
// Usage and fixture-build instructions: docs/pwa-update-verification.md
const { chromium, devices } = require(process.env.AURORA_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const ts = require(process.cwd() + '/node_modules/typescript');
const [baselineDirectory, fixedDirectory, baselineUpdater] = process.argv.slice(2);
if (!baselineDirectory || !fixedDirectory || !baselineUpdater) {
    throw new Error('Usage: node scripts/verify-pwa-update-streams.cjs <baseline-dist> <fixed-dist> <baseline-updater.ts>');
}
const builds = { baseline: path.resolve(baselineDirectory), fixed: path.resolve(fixedDirectory) };
for (const directory of Object.values(builds)) {
    if (!fs.existsSync(path.join(directory, 'sw.js')))
        throw new Error('Missing generated worker: ' + directory);
}
const compile = p => ts.transpileModule(fs.readFileSync(p, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
let build = 'baseline', client = 'baseline', revision = 1, delayHeaders = false;
const connections = new Set();
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/api/library/scan/status') {
        connections.add(res);
        req.on('close', () => connections.delete(res));
        res.setHeader('Content-Type', 'text/event-stream');
        if (!delayHeaders)
            res.write('data: {"phase":"idle"}\n\n');
        return;
    }
    if (url.pathname === '/api/updater.js' || url.pathname === '/api/serverEvents') {
        res.setHeader('Content-Type', 'application/javascript');
        return res.end(compile(url.pathname.endsWith('serverEvents') ? 'src/utils/serverEvents.ts' : client === 'baseline' ? baselineUpdater : 'src/utils/pwaUpdate.ts'));
    }
    if (url.pathname === '/api/probe') {
        res.setHeader('Content-Type', 'text/html');
        return res.end(`<html><body><h1>Build ${revision}</h1><button id="update">Reload</button><p id="result">Starting</p><script type="module">
  import {createPwaUpdateHandler,setPwaUpdateHandler,applyPendingPwaUpdate} from '/api/updater.js';
  ${client === 'baseline' ? '' : "import {ServerEventStream} from '/api/serverEvents';"}
  sessionStorage.setItem('loads',String(Number(sessionStorage.getItem('loads')||0)+1));
  window.reg=await navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'});
  await navigator.serviceWorker.ready;
  if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));
  setPwaUpdateHandler(createPwaUpdateHandler(window.reg,navigator.serviceWorker,()=>{sessionStorage.setItem('reloads',String(Number(sessionStorage.getItem('reloads')||0)+1));location.reload()}));
  window.stream=new ${client === 'baseline' ? 'EventSource' : 'ServerEventStream'}('/api/library/scan/status');
  window.apply=applyPendingPwaUpdate;
  document.querySelector('#update').onclick=()=>{document.querySelector('#result').textContent='Updating';void applyPendingPwaUpdate().catch(e=>document.querySelector('#result').textContent=e.message)};
  document.querySelector('#result').textContent='Ready';
  </script></body></html>`);
    }
    const file = path.join(builds[build], url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
    if (!fs.existsSync(file)) {
        res.statusCode = 404;
        return res.end('missing');
    }
    res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
    if (url.pathname === '/sw.js')
        return res.end(fs.readFileSync(file, 'utf8') + `\n/* probe revision ${revision} */`);
    fs.createReadStream(file).pipe(res);
});
(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ headless: true });
    try {
        for (const scenario of [
            { name: 'baseline-idle', build: 'baseline', client: 'baseline', fails: true },
            { name: 'new-client-legacy-worker', build: 'baseline', client: 'fixed' },
            { name: 'fixed-desktop-two-tabs', build: 'fixed', client: 'fixed', twoTabs: true },
            { name: 'fixed-android-slow-stream', build: 'fixed', client: 'fixed', twoTabs: true, mobile: true, delayed: true },
        ]) {
            build = scenario.build;
            client = scenario.client;
            revision = 1;
            delayHeaders = !!scenario.delayed;
            const context = await browser.newContext(scenario.mobile ? devices['Pixel 7'] : {});
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', e => errors.push(e.message));
            await page.goto(origin + '/api/probe');
            await page.waitForFunction(() => document.querySelector('#result')?.textContent === 'Ready');
            let other;
            if (scenario.twoTabs) {
                other = await context.newPage();
                await other.goto(origin + '/api/probe');
                await other.waitForFunction(() => document.querySelector('#result')?.textContent === 'Ready');
            }
            await page.waitForTimeout(300);
            build = 'fixed';
            revision = 2;
            await page.evaluate(() => window.reg.update());
            await page.waitForFunction(() => window.reg.waiting);
            const started = Date.now();
            await page.locator('#update').click();
            if (scenario.fails) {
                await page.getByText('The update is taking longer than expected. Please try again.', { exact: true }).waitFor({ timeout: 20000 });
                assert.equal(await page.evaluate(() => sessionStorage.getItem('loads')), '1');
            }
            else {
                await page.waitForFunction(() => sessionStorage.getItem('reloads') === '1' && document.querySelector('#result')?.textContent === 'Ready', {}, { timeout: 20000 });
                assert.equal(await page.evaluate(() => sessionStorage.getItem('loads')), '2');
                if (other)
                    assert.equal(await other.evaluate(() => sessionStorage.getItem('loads')), '1');
            }
            console.log(JSON.stringify({ scenario: scenario.name, ms: Date.now() - started, errors, result: await page.locator('#result').innerText(), worker: await page.evaluate(() => ({ active: window.reg.active?.state, waiting: window.reg.waiting?.state })), openStreams: connections.size }));
            assert.deepEqual(errors, []);
            await context.close();
            for (const res of connections)
                res.end();
            connections.clear();
        }
    }
    finally {
        await browser.close();
        server.closeAllConnections();
        server.close();
    }
})().catch(e => { console.error(e); server.closeAllConnections(); server.close(); process.exit(1); });
