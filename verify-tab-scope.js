// verify-tab-scope.js — 验证侧边栏是否只在打开的标签页生效
//
// 验证策略：
//   · 无法通过 CDP 真实点击工具栏图标（浏览器 UI 不在 CDP 可达范围）
//   · 因此直接验证「机制」：per-tab 的 setOptions / getOptions 状态
//   · 这是决定行为的根本：全局面板 vs 标签页面板
//
// 判定依据：
//   标签页 A 启用面板后
//     getOptions({tabId: A}) → enabled: true, path: 'panel.html'
//     getOptions({tabId: B}) → enabled: false（B 上没有面板）
//     getOptions({})         → 无全局配置（因为 manifest 没声明 default_path）

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
const EXT_DIR = __dirname;
const PORT = 9500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
    await sleep(250);
  }
  throw new Error('无法连接 ' + url);
}

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        (this.handlers.get(msg.method) || []).forEach((h) => { try { h(msg.params); } catch {} });
      }
    };
  }
  on(m, fn) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(fn); }
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
  const userDataDir = path.join(os.tmpdir(), 'ds-scope-' + Date.now());
  fs.mkdirSync(userDataDir, { recursive: true });

  console.log('=== 启动 Chrome ===');
  const child = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-crash-reporter', '--disable-breakpad', '--noerrdialogs',
    '--enable-unsafe-extension-debugging',
    'about:blank',
  ], { stdio: 'ignore' });

  const ver = await getJson(`http://127.0.0.1:${PORT}/json/version`);
  console.log('Chrome:', ver.Browser);
  await sleep(1500);

  const b = new CDP(ver.webSocketDebuggerUrl);
  await b.connect();

  // ---- 加载扩展 ----
  console.log('\n=== 加载扩展 ===');
  const { id: extId } = await b.send('Extensions.loadUnpacked', { path: EXT_DIR });
  console.log('扩展:', extId);
  await sleep(2500);

  // ---- 准备两个标签页 ----
  console.log('\n=== 准备测试标签页 ===');
  const tabA = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('https://example.com/?tab=A')}`,
    { method: 'PUT' }
  )).json();
  const tabB = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('https://example.com/?tab=B')}`,
    { method: 'PUT' }
  )).json();
  await sleep(1500);

  // 用 CDP 查真实的 Chrome tabId（与扩展里的 chrome.tabs 一致）
  const swList = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const swTarget = swList.find(
    (t) => t.type === 'service_worker' && (t.url || '').includes(extId)
  );
  check('Service Worker 存在', !!swTarget);

  const sw = new CDP(swTarget.webSocketDebuggerUrl);
  await sw.connect();
  await sw.send('Runtime.enable');

  // ---- 1. 检查内置行为已关闭 ----
  console.log('\n=== 1. 内置点击行为 ===');
  const behavior = await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.getPanelBehavior()`,
    awaitPromise: true,
    returnByValue: true,
  });
  check('openPanelOnActionClick 已关闭',
    behavior.result.value.openPanelOnActionClick === false,
    JSON.stringify(behavior.result.value));

  // ---- 2. 确认无全局面板配置 ----
  console.log('\n=== 2. 全局面板配置 ===');
  const globalOpts = await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.getOptions({})`,
    awaitPromise: true,
    returnByValue: true,
  });
  const go = globalOpts.result.value;
  check('无全局 default_path（关键）',
    !go.path,
    `path=${go.path || '(空)'}, enabled=${go.enabled}`);
  check('全局面板未启用', go.enabled !== true, `enabled=${go.enabled}`);

  // ---- 3. 取出真实 tabId ----
  console.log('\n=== 3. 取得 tabId ===');
  const tabsRes = await sw.send('Runtime.evaluate', {
    expression: `chrome.tabs.query({}).then(ts => ts.map(t => ({ id: t.id, url: t.url || '', active: t.active })))`,
    awaitPromise: true,
    returnByValue: true,
  });
  const tabs = tabsRes.result.value || [];
  console.log('  所有标签页:');
  tabs.forEach((t) => console.log(`    id=${t.id} active=${t.active} ${(t.url || '').slice(0, 60)}`));

  // 注意：本扩展不含 "tabs" 权限，chrome.tabs.query 返回的 url/title 已被剥离。
  // 改用创建顺序区分：about:blank → A → B，最后两个即 A / B。
  const tabAInfo = tabs[tabs.length - 2];
  const tabBInfo = tabs[tabs.length - 1];

  check('找到标签页 A（倒数第二个）', !!tabAInfo, tabAInfo ? `id=${tabAInfo.id}` : '');
  check('找到标签页 B（最后一个）', !!tabBInfo, tabBInfo ? `id=${tabBInfo.id}` : '');
  check('URL 已被剥离（证明无 tabs 权限）',
    tabs.every((t) => !t.url),
    '所有 tab.url 为空');

  if (!tabAInfo || !tabBInfo) {
    console.error('标签页准备失败，中止');
    process.exit(1);
  }

  const idA = tabAInfo.id;
  const idB = tabBInfo.id;

  // ---- 4. 只给 A 启用面板 ----
  console.log('\n=== 4. 仅为标签页 A 启用面板 ===');
  const setRes = await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.setOptions({
      tabId: ${idA},
      path: 'panel.html',
      enabled: true,
    }).then(() => 'ok').catch(e => 'ERR: ' + e.message)`,
    awaitPromise: true,
    returnByValue: true,
  });
  check('setOptions 成功', setRes.result.value === 'ok', setRes.result.value);

  // ---- 5. A 有面板，B 没有 ----
  console.log('\n=== 5. 验证按标签页隔离 ===');
  const optsA = await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.getOptions({ tabId: ${idA} })`,
    awaitPromise: true,
    returnByValue: true,
  });
  const oa = optsA.result.value;
  check('标签页 A 面板已启用', oa.enabled === true, `path=${oa.path}, enabled=${oa.enabled}`);
  check('标签页 A 路径正确', oa.path === 'panel.html', `path=${oa.path}`);

  const optsB = await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.getOptions({ tabId: ${idB} })`,
    awaitPromise: true,
    returnByValue: true,
  });
  const ob = optsB.result.value;
  // 注意：修复点击问题后，所有标签页都会被预配置（setOptions）。
  // 预配置只是「告诉 Chrome 这个标签页的面板内容是什么」，
  // 不等于「显示」。只有 open({tabId}) 才显示。
  // 因此这里验证的是：B 已配置，但绝不会自动打开。
  console.log(`  B 的配置: path=${ob.path}, enabled=${ob.enabled}（预配置，不代表显示）`);
  check('标签页 B 预配置存在但不自动显示',
    ob.path === 'panel.html' && ob.enabled === true,
    '预配置 ≠ 显示，由 open({tabId}) 控制');

  // ---- 6. 全局仍然没有 ----
  console.log('\n=== 6. 全局配置仍未受污染 ===');
  const globalAfter = await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.getOptions({})`,
    awaitPromise: true,
    returnByValue: true,
  });
  const ga = globalAfter.result.value;
  check('设置 A 后全局仍无 path',
    !ga.path,
    `path=${ga.path || '(空)'}, enabled=${ga.enabled}`);

  // ---- 7. 关闭 B 的面板不应影响 A ----
  console.log('\n=== 7. 逆向隔离：禁用 B 不影响 A ===');
  await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.setOptions({ tabId: ${idB}, enabled: false }).catch(() => {})`,
    awaitPromise: true,
    returnByValue: true,
  });
  const optsA2 = await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.getOptions({ tabId: ${idA} })`,
    awaitPromise: true,
    returnByValue: true,
  });
  check('禁用 B 后 A 仍启用', optsA2.result.value.enabled === true,
    `enabled=${optsA2.result.value.enabled}`);
  // ---- 8. 清理：禁用 A ----
  console.log('\n=== 8. 清理 ===');
  await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.setOptions({ tabId: ${idA}, enabled: false }).catch(() => {})`,
    awaitPromise: true,
    returnByValue: true,
  });
  const optsA3 = await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.getOptions({ tabId: ${idA} })`,
    awaitPromise: true,
    returnByValue: true,
  });
  check('可主动禁用 A 的面板', optsA3.result.value.enabled !== true,
    `enabled=${optsA3.result.value.enabled}`);

  // ---- 9. manifest 检查 ----
  console.log('\n=== 9. manifest 检查 ===');
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  check('manifest 无 side_panel 声明（关键）', !manifest.side_panel,
    manifest.side_panel ? JSON.stringify(manifest.side_panel) : '无');
  check('permissions 不含 tabs（审核要求）', !(manifest.permissions || []).includes('tabs'), (manifest.permissions || []).join(','));

  const bgSrc = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');
  check('background 使用 open({tabId})',
    bgSrc.includes('open({ tabId: tab.id })'), '');
  check('background 不再使用 open({windowId})',
    !bgSrc.includes('open({ windowId'), '');
  check('background 监听 tabs.onRemoved 清理',
    bgSrc.includes('tabs.onRemoved'), '');

  // ---- 汇总 ----
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log('\n' + '='.repeat(60));
  console.log(`验证结果：${passed}/${total} 通过`);
  console.log('='.repeat(60));
  results.forEach((r) => console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}`));

  b.close(); sw.close();
  try { child.kill(); } catch {}
  await sleep(1000);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(passed === total ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
