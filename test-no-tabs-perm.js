// test-no-tabs-perm.js — 验证去掉 tabs 权限后功能是否仍正常
//
// 背景：Edge 审核明确「请求不必要的权限会被拒」。
// chrome.tabs 的多个能力其实不需要 "tabs" 权限：
//   · tabs.query / onActivated / onUpdated / onRemoved  → 不需要
//   · TAB_ID_NONE 常量                                   → 不需要
//   · 只有读取 tab.url / tab.title / tab.favIconUrl       → 需要
//
// 本扩展只用 tab.id（配置面板用），不读 url/title，
// 因此理论上可以移除 "tabs" 权限。

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- 浏览器路径：环境变量 CHROME_PATH 优先，否则按平台回退 ----
// Windows 默认值保持不变；macOS / Linux 自动探测常见安装位置。
function resolveChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) {
    console.warn('⚠️  未找到 Chrome，可用环境变量 CHROME_PATH 指定；回退到 ' + candidates[0]);
  }
  return hit || candidates[0];
}

const CHROME = resolveChrome();
const SRC = __dirname;
const PORT = 9540;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
    await sleep(250);
  }
  throw new Error('无法连接 ' + url);
}

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 40000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`);
}

(async () => {
  const userDataDir = path.join(os.tmpdir(), 'ds-notabs-' + Date.now());
  fs.mkdirSync(userDataDir, { recursive: true });

  const child = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-crash-reporter', '--disable-breakpad', '--noerrdialogs',
    '--enable-unsafe-extension-debugging',
    'about:blank',
  ], { stdio: 'ignore' });

  const ver = await getJson(`http://127.0.0.1:${PORT}/json/version`);
  await sleep(1500);
  const b = new CDP(ver.webSocketDebuggerUrl);
  await b.connect();
  const { id: extId } = await b.send('Extensions.loadUnpacked', { path: SRC });
  console.log('扩展:', extId);
  await sleep(3000);

  // 检查实际申请的权限
  console.log('\n=== 1. 权限检查 ===');
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const swTarget = list.find((t) => t.type === 'service_worker' && (t.url || '').includes(extId));
  check('Service Worker 存在', !!swTarget);

  const sw = new CDP(swTarget.webSocketDebuggerUrl);
  await sw.connect();
  await sw.send('Runtime.enable');

  const perms = await sw.send('Runtime.evaluate', {
    expression: `chrome.permissions.getAll()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const p = perms.result.value;
  console.log('  实际权限:', JSON.stringify(p));
  check('不含 tabs 权限', !(p.permissions || []).includes('tabs'),
    (p.permissions || []).join(','));

  // ---- 2. 无 tabs 权限下 tabs API 是否可用 ----
  console.log('\n=== 2. tabs API 可用性（无 tabs 权限）===');
  const api = await sw.send('Runtime.evaluate', {
    expression: `(async () => {
      const out = {};
      out.hasTabsApi = typeof chrome.tabs === 'object';
      out.hasQuery = typeof chrome.tabs?.query === 'function';
      out.hasOnActivated = !!chrome.tabs?.onActivated;
      out.hasOnUpdated = !!chrome.tabs?.onUpdated;
      out.hasOnRemoved = !!chrome.tabs?.onRemoved;
      out.tabIdNone = chrome.tabs?.TAB_ID_NONE;

      try {
        const t = await chrome.tabs.query({});
        out.queryOk = true;
        out.tabCount = t.length;
        out.sampleId = t[0]?.id;
        // 无 tabs 权限时 url/title 应被剥离
        out.urlStripped = t[0] ? (t[0].url === undefined || t[0].url === '') : null;
        out.titleStripped = t[0] ? (t[0].title === undefined || t[0].title === '') : null;
      } catch (e) {
        out.queryOk = false;
        out.queryErr = e.message;
      }
      return out;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const a = api.result.value;
  console.log('  ' + JSON.stringify(a, null, 2).replace(/\n/g, '\n  '));

  check('chrome.tabs API 存在', a.hasTabsApi === true);
  check('tabs.query 可调用', a.queryOk === true, a.queryErr || `${a.tabCount} 个标签页`);
  check('能拿到 tab.id（配置面板所需）', typeof a.sampleId === 'number', `id=${a.sampleId}`);
  check('onActivated 事件可用', a.hasOnActivated === true);
  check('onUpdated 事件可用', a.hasOnUpdated === true);
  check('onRemoved 事件可用', a.hasOnRemoved === true);
  check('url 已被剥离（说明确实无 tabs 权限）',
    a.urlStripped === true, `urlStripped=${a.urlStripped}`);

  // ---- 3. 面板配置是否仍工作 ----
  console.log('\n=== 3. 面板配置（核心功能）===');
  await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('https://example.com/')}`,
    { method: 'PUT' }
  )).json();
  await sleep(2500);

  const tabRes = await sw.send('Runtime.evaluate', {
    expression: `chrome.tabs.query({}).then(t => t.map(x => x.id))`,
    awaitPromise: true,
    returnByValue: true,
  });
  const ids = tabRes.result.value || [];
  const testId = ids[ids.length - 1];

  const setRes = await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.setOptions({
      tabId: ${testId}, path: 'panel.html', enabled: true
    }).then(() => 'OK').catch(e => 'ERR: ' + e.message)`,
    awaitPromise: true,
    returnByValue: true,
  });
  check('sidePanel.setOptions 成功', setRes.result.value === 'OK', setRes.result.value);

  const getRes = await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.getOptions({ tabId: ${testId} })`,
    awaitPromise: true,
    returnByValue: true,
  });
  check('getOptions 返回正确',
    getRes.result.value.path === 'panel.html' && getRes.result.value.enabled === true,
    JSON.stringify(getRes.result.value));

  // ---- 4. DNR 是否仍工作 ----
  console.log('\n=== 4. DNR 规则 ===');
  const rules = await sw.send('Runtime.evaluate', {
    expression: `chrome.declarativeNetRequest.getEnabledRulesets()`,
    awaitPromise: true,
    returnByValue: true,
  });
  check('DNR 规则启用',
    Array.isArray(rules.result.value) && rules.result.value.includes('deepseek_frame_rules'),
    (rules.result.value || []).join(','));

  // ---- 5. manifest 检查 ----
  console.log('\n=== 5. manifest ===');
  const m = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  check('manifest 不含 tabs 权限', !(m.permissions || []).includes('tabs'),
    (m.permissions || []).join(','));

  // ---- 汇总 ----
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log('\n' + '='.repeat(58));
  console.log(`验证结果：${passed}/${total} 通过`);
  console.log('='.repeat(58));
  results.forEach((r) => console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}`));

  b.close(); sw.close();
  try { child.kill(); } catch {}
  await sleep(1000);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(passed === total ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
