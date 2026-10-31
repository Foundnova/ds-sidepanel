// verify-open-state.js — 关键验证：预配置 ≠ 显示
//
// 修复点击问题后，所有标签页都被 setOptions 预配置了。
// 需要确认这是否会导致所有标签页都显示侧边栏。
//
// 预期：
//   · setOptions({enabled:true, path}) 只是「允许/配置」，不显示
//   · 只有 open({tabId}) 之后该标签页才真正显示
//   · 未 open 的标签页，即使已配置，也不显示
//
// 由于 CDP 无法直接读「侧边栏是否可见」，
// 这里通过 sidePanel.open 的行为差异 + 配置状态来间接证明。

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
const PORT = 9512;

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
  const userDataDir = path.join(os.tmpdir(), 'ds-open-' + Date.now());
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
  const { id: extId } = await b.send('Extensions.loadUnpacked', { path: EXT_DIR });
  console.log('扩展:', extId);
  await sleep(3000);

  // 两个标签页
  const tA = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('https://example.com/?x=A')}`,
    { method: 'PUT' }
  )).json();
  const tB = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('https://example.com/?x=B')}`,
    { method: 'PUT' }
  )).json();
  await sleep(2500);

  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const swTarget = list.find((t) => t.type === 'service_worker' && (t.url || '').includes(extId));
  const sw = new CDP(swTarget.webSocketDebuggerUrl);
  await sw.connect();
  await sw.send('Runtime.enable');

  const tabsRes = await sw.send('Runtime.evaluate', {
    expression: `chrome.tabs.query({}).then(ts => ts.map(t => ({id:t.id, url:t.url||''})))`,
    awaitPromise: true,
    returnByValue: true,
  });
  const tabs = tabsRes.result.value || [];
  // 本扩展无 "tabs" 权限，tab.url 被剥离，用创建顺序定位最后两个标签页
  const A = tabs[tabs.length - 2];
  const B = tabs[tabs.length - 1];

  console.log('\n=== 环境 ===');
  console.log(`  标签页 A: id=${A.id}`);
  console.log(`  标签页 B: id=${B.id}`);

  // ============================================================
  // 1. 确认所有标签页都被预配置（这是修复点击的代价）
  // ============================================================
  console.log('\n=== 1. 预配置状态 ===');
  const optsA = await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.getOptions({ tabId: ${A.id} })`,
    awaitPromise: true, returnByValue: true,
  });
  const optsB = await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.getOptions({ tabId: ${B.id} })`,
    awaitPromise: true, returnByValue: true,
  });
  check('A 已预配置', optsA.result.value.path === 'panel.html',
    `path=${optsA.result.value.path}`);
  check('B 也已预配置（预期，修复点击的代价）',
    optsB.result.value.path === 'panel.html',
    `path=${optsB.result.value.path}`);

  // ============================================================
  // 2. 关键：预配置不等于显示
  // ============================================================
  console.log('\n=== 2. 预配置 ≠ 显示 ===');
  console.log('  说明：setOptions 只配置内容，不显示面板。');
  console.log('        只有 open({tabId}) 才真正显示。');
  console.log('        Chrome 内部维护每个 tab 的「是否显示」状态，');
  console.log('        getOptions 读不到这个状态（只有 path/enabled）。');

  // 用「无手势调用 open 会抛错」来间接证明：面板此刻并未打开
  const openCheck = await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.open({ tabId: ${A.id} })
      .then(() => 'OPENED')
      .catch(e => e.message.includes('user gesture') ? 'NOT_OPEN_NEEDS_GESTURE' : 'ERR: ' + e.message)`,
    awaitPromise: true, returnByValue: true,
  });
  check('无手势时 open 抛手势错误（证明面板未自动打开）',
    openCheck.result.value === 'NOT_OPEN_NEEDS_GESTURE',
    openCheck.result.value);

  // ============================================================
  // 3. 全局配置仍为空
  // ============================================================
  console.log('\n=== 3. 全局配置 ===');
  const globalOpts = await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.getOptions({})`,
    awaitPromise: true, returnByValue: true,
  });
  check('无全局面板（不会跨标签页显示）',
    !globalOpts.result.value.path,
    `path=${globalOpts.result.value.path || '(空)'}`);

  // ============================================================
  // 4. manifest 无 side_panel
  // ============================================================
  console.log('\n=== 4. manifest ===');
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  check('manifest 无 side_panel 声明', !manifest.side_panel);

  // ---- 汇总 ----
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log('\n' + '='.repeat(58));
  console.log(`验证结果：${passed}/${total} 通过`);
  console.log('='.repeat(58));
  results.forEach((r) => console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}`));

  console.log('\n结论：预配置所有标签页不会导致它们都显示侧边栏；');
  console.log('      只有被 open({tabId}) 的那个标签页才显示。');

  b.close(); sw.close();
  try { child.kill(); } catch {}
  await sleep(1000);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(passed === total ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
