// verify.js — 最小化验证
//
// 只验证这个扩展的核心职责：
//   1. 扩展能加载
//   2. 点击图标能打开侧边栏（openPanelOnActionClick）
//   3. DNR 规则已启用
//   4. iframe 能加载 DeepSeek（sessionStorage 可访问 = 嵌入成功）
//   5. 无残留的冗余代码

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
const PORT = 9490;

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
  const userDataDir = path.join(os.tmpdir(), 'ds-min-' + Date.now());
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

  // ---- 1. 加载扩展 ----
  console.log('\n=== 1. 加载扩展 ===');
  let extId = null;
  try {
    const r = await b.send('Extensions.loadUnpacked', { path: EXT_DIR });
    extId = r.id;
    check('扩展加载', true, extId);
  } catch (e) {
    check('扩展加载', false, e.message);
    b.close(); child.kill();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    process.exit(1);
  }
  await sleep(2500);

  // ---- 2. 检查点击行为 + DNR ----
  console.log('\n=== 2. 点击行为与规则 ===');
  const swList = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const swTarget = swList.find(
    (t) => t.type === 'service_worker' && (t.url || '').includes(extId)
  );
  check('Service Worker 存在', !!swTarget);

  if (swTarget) {
    const sw = new CDP(swTarget.webSocketDebuggerUrl);
    await sw.connect();
    await sw.send('Runtime.enable');
    const diag = await sw.send('Runtime.evaluate', {
      expression: `(async () => {
        const out = {};
        try { out.behavior = await chrome.sidePanel.getPanelBehavior(); } catch (e) { out.behaviorErr = e.message; }
        try { out.hasActionListener = chrome.action.onClicked.hasListeners(); } catch (e) { out.actionErr = e.message; }
        try { out.rules = await chrome.declarativeNetRequest.getEnabledRulesets(); } catch (e) { out.rulesErr = e.message; }
        try { out.globalOptions = await chrome.sidePanel.getOptions({}); } catch (e) { out.globalErr = e.message; }
        return out;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const dv = diag.result.value;
    // 现在是按标签页模式：关闭内置点击行为，改由 onClicked + tabId 控制
    check('openPanelOnActionClick 已关闭（按标签页模式）',
      dv.behavior && dv.behavior.openPanelOnActionClick === false,
      JSON.stringify(dv.behavior));
    check('action.onClicked 监听器存在', dv.hasActionListener === true);
    check('DNR 规则已启用',
      Array.isArray(dv.rules) && dv.rules.includes('deepseek_frame_rules'),
      (dv.rules || []).join(','));
    check('无全局面板配置（不会跨标签页）',
      dv.globalOptions && !dv.globalOptions.path,
      `path=${(dv.globalOptions && dv.globalOptions.path) || '(空)'}`);
    sw.close();
  }

  // ---- 3. 打开 panel ----
  console.log('\n=== 3. 打开侧边栏 ===');
  const tab = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`chrome-extension://${extId}/panel.html`)}`,
    { method: 'PUT' }
  )).json();

  const p = new CDP(tab.webSocketDebuggerUrl);
  await p.connect();
  await p.send('Page.enable');
  await p.send('Runtime.enable');
  await sleep(1500);

  const panelInfo = await p.send('Runtime.evaluate', {
    expression: `({
      href: location.href,
      hasFrame: !!document.getElementById('frame'),
      hasLoading: !!document.getElementById('loading'),
      hasError: !!document.getElementById('error'),
      frameSrc: document.getElementById('frame')?.src,
    })`,
    returnByValue: true,
  });
  const pi = panelInfo.result.value;
  check('iframe 存在', pi.hasFrame === true, pi.frameSrc);
  check('加载指示器存在', pi.hasLoading === true);
  check('错误提示存在', pi.hasError === true);

  // ---- 4. 等待 DeepSeek 加载 ----
  console.log('\n=== 4. 等待 DeepSeek 加载（16s）===');
  await sleep(16000);

  const afterLoad = await p.send('Runtime.evaluate', {
    expression: `({
      loadingHidden: (() => {
        const l = document.getElementById('loading');
        return l.style.display === 'none' || getComputedStyle(l).opacity === '0';
      })(),
      errorShown: document.getElementById('error')?.classList.contains('show'),
    })`,
    returnByValue: true,
  });
  check('加载指示器已隐藏', afterLoad.result.value.loadingHidden === true);
  check('未显示错误', afterLoad.result.value.errorShown === false);

  // 检查 DeepSeek 是否真的加载（sessionStorage 可访问 = 嵌入成功）
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const dsTarget = list.find((t) => (t.url || '').includes('deepseek'));
  check('DeepSeek iframe 已加载', !!dsTarget, dsTarget ? dsTarget.url : '未找到');

  if (dsTarget) {
    const d = new CDP(dsTarget.webSocketDebuggerUrl);
    await d.connect();
    await d.send('Runtime.enable');
    const r = await d.send('Runtime.evaluate', {
      expression: `(() => {
        const root = document.getElementById('root');
        return {
          readyState: document.readyState,
          sessionStorage: (() => { try { sessionStorage.getItem('x'); return 'OK'; } catch (e) { return e.name; } })(),
          rootChildren: root ? root.children.length : -1,
          bodyTextLen: (document.body?.innerText || '').length,
        };
      })()`,
      returnByValue: true,
    });
    const dv = r.result.value;
    check('sessionStorage 可访问', dv.sessionStorage === 'OK', dv.sessionStorage);
    check('React 已挂载', dv.rootChildren > 0, `root 子节点 ${dv.rootChildren}`);
    check('页面有内容', dv.bodyTextLen > 0, `${dv.bodyTextLen} 字符`);
    d.close();
  }

  // ---- 5. 检查冗余代码已清除 ----
  console.log('\n=== 5. 冗余代码检查 ===');
  const files = fs.readdirSync(EXT_DIR).filter((f) => f.endsWith('.js'));
  const removed = ['content.js', 'context-bar.js', 'selection.js'];
  removed.forEach((f) => {
    check(`${f} 已删除`, !files.includes(f));
  });

  const panelJs = fs.readFileSync(path.join(EXT_DIR, 'panel.js'), 'utf8');
  check('panel.js 无划词逻辑', !panelJs.includes('selection') && !panelJs.includes('promptInput'));
  check('panel.js 无上下文逻辑', !panelJs.includes('context') && !panelJs.includes('chip'));

  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  check('manifest 无 content_scripts', !manifest.content_scripts);
  check('manifest 无 side_panel 声明（按标签页模式）',
    !manifest.side_panel,
    manifest.side_panel ? JSON.stringify(manifest.side_panel) : '无');
  check('manifest 权限精简（仅 2 项，无 tabs）',
    manifest.permissions.length === 2 &&
    manifest.permissions.includes('sidePanel') &&
    manifest.permissions.includes('declarativeNetRequest') &&
    !manifest.permissions.includes('tabs'),
    manifest.permissions.join(','));
  check('manifest 无 <all_urls>',
    !(manifest.host_permissions || []).includes('<all_urls>'),
    (manifest.host_permissions || []).join(','));

  const bgSrc = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');
  check('background 使用 open({tabId})（按标签页）',
    bgSrc.includes('open({ tabId: tab.id })'), '');
  check('background 不再使用 open({windowId})',
    !bgSrc.includes('open({ windowId'), '');
  check('background 监听 tabs.onRemoved 清理',
    bgSrc.includes('tabs.onRemoved'), '');

  // ---- 汇总 ----
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log('\n' + '='.repeat(58));
  console.log(`验证结果：${passed}/${total} 通过`);
  console.log('='.repeat(58));
  results.forEach((r) => console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}`));

  b.close(); p.close();
  try { child.kill(); } catch {}
  await sleep(1000);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(passed === total ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
