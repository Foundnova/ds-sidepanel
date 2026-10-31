// verify-edge.js — 用真实 Microsoft Edge 加载打包产物，验证能装能用
//
// 流程：
//   1. 解压 dist/deepseek-sidebar-v*.zip 到临时目录
//   2. 用 msedge.exe 加载该目录（--load-extension）
//   3. 检查扩展是否加载、sidePanel API 是否可用
//   4. 检查 iframe 能否加载 DeepSeek
//
// 注意：品牌版 Edge 可能也禁止 --load-extension，
// 所以同时用 CDP Extensions.loadUnpacked 作为备选路径。

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- 浏览器路径：环境变量 EDGE_PATH 优先，否则按平台回退 ----
// Windows 默认值保持不变；macOS / Linux 自动探测常见安装位置。
function resolveEdge() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
  ].filter(Boolean);
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) {
    console.warn('⚠️  未找到 Edge，可用环境变量 EDGE_PATH 指定；回退到 ' + candidates[0]);
  }
  return hit || candidates[0];
}

const EDGE = resolveEdge();
const SRC = __dirname;
const PORT = 9520;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 100) {
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
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); }
      }, 40000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`);
}

// 解压 zip（Node 无内置 unzip）
//   · Windows  → PowerShell Expand-Archive
//   · macOS/Linux → 系统自带 unzip
function unzipTo(zipPath, destDir) {
  const { execSync } = require('child_process');
  fs.mkdirSync(destDir, { recursive: true });

  if (process.platform === 'win32') {
    // PowerShell 单引号字符串内，字面单引号需写成两个单引号
    const q = (s) => s.replace(/'/g, "''");
    const cmd = `Expand-Archive -LiteralPath '${q(zipPath)}' -DestinationPath '${q(destDir)}' -Force`;
    execSync(`powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`, { stdio: 'pipe' });
  } else {
    // JSON.stringify 生成的双引号路径可安全传给 POSIX shell
    execSync(`unzip -o -q ${JSON.stringify(zipPath)} -d ${JSON.stringify(destDir)}`, { stdio: 'pipe' });
  }
}

(async () => {
  // ---- 1. 找 zip 并解压 ----
  const distDir = path.join(SRC, 'dist');
  const zips = fs.existsSync(distDir)
    ? fs.readdirSync(distDir).filter((f) => f.endsWith('.zip'))
    : [];
  if (!zips.length) {
    console.error('❌ dist 目录没有 zip，请先运行 node build-zip.js');
    process.exit(1);
  }
  const zipPath = path.join(distDir, zips[0]);
  console.log('=== 1. 解压打包产物 ===');
  console.log('  zip:', path.basename(zipPath));

  const extractDir = path.join(os.tmpdir(), 'ds-edge-extract-' + Date.now());
  unzipTo(zipPath, extractDir);

  const extracted = fs.readdirSync(extractDir);
  console.log('  解压内容:', extracted.join(', '));
  check('manifest.json 在顶层', extracted.includes('manifest.json'));
  check('icons 目录存在', extracted.includes('icons'));
  check('无嵌套目录',
    !extracted.some((f) => {
      const full = path.join(extractDir, f);
      return fs.statSync(full).isDirectory() &&
             fs.existsSync(path.join(full, 'manifest.json'));
    }));

  // ---- 2. 启动 Edge ----
  console.log('\n=== 2. 启动 Microsoft Edge ===');
  const userDataDir = path.join(os.tmpdir(), 'ds-edge-profile-' + Date.now());
  fs.mkdirSync(userDataDir, { recursive: true });

  const child = spawn(EDGE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--noerrdialogs',
    '--enable-unsafe-extension-debugging',
    'about:blank',
  ], { stdio: 'ignore' });

  let ver;
  try {
    ver = await getJson(`http://127.0.0.1:${PORT}/json/version`);
  } catch (e) {
    console.error('❌ Edge 启动失败:', e.message);
    try { child.kill(); } catch {}
    process.exit(1);
  }
  console.log('  Edge:', ver.Browser);
  check('Edge 启动成功', true, ver.Browser);

  const b = new CDP(ver.webSocketDebuggerUrl);
  await b.connect();
  await sleep(2000);

  // ---- 3. 加载解压后的扩展 ----
  console.log('\n=== 3. 加载扩展 ===');
  let extId = null;
  try {
    const r = await b.send('Extensions.loadUnpacked', { path: extractDir });
    extId = r.id;
    check('扩展加载成功', true, extId);
  } catch (e) {
    check('扩展加载成功', false, e.message);
    // 尝试 --load-extension 路径
    console.log('  尝试其它方式…');
  }

  if (!extId) {
    console.log('\n⚠️  无法通过 CDP 加载，尝试直接检查 manifest 有效性');
    const m = JSON.parse(fs.readFileSync(path.join(extractDir, 'manifest.json'), 'utf8'));
    check('manifest 可解析', !!m.name, m.name);
    b.close();
    try { child.kill(); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
    process.exit(1);
  }

  await sleep(3000);

  // ---- 4. 检查 Edge 里的扩展状态 ----
  console.log('\n=== 4. 扩展运行状态 ===');
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const swTarget = list.find(
    (t) => t.type === 'service_worker' && (t.url || '').includes(extId)
  );
  check('Service Worker 在 Edge 中运行', !!swTarget,
    swTarget ? swTarget.url : '未找到');

  if (swTarget) {
    const sw = new CDP(swTarget.webSocketDebuggerUrl);
    await sw.connect();
    await sw.send('Runtime.enable');

    const api = await sw.send('Runtime.evaluate', {
      expression: `(async () => {
        const out = {};
        out.hasSidePanel = typeof chrome.sidePanel === 'object';
        out.hasOpen = typeof chrome.sidePanel?.open === 'function';
        out.hasSetOptions = typeof chrome.sidePanel?.setOptions === 'function';
        out.hasSetPanelBehavior = typeof chrome.sidePanel?.setPanelBehavior === 'function';
        try { out.behavior = await chrome.sidePanel.getPanelBehavior(); } catch (e) { out.behaviorErr = e.message; }
        try { out.rules = await chrome.declarativeNetRequest.getEnabledRulesets(); } catch (e) { out.rulesErr = e.message; }
        out.hasOnClicked = chrome.action?.onClicked?.hasListeners ? chrome.action.onClicked.hasListeners() : null;
        return out;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const av = api.result.value;
    console.log('  API 状态:', JSON.stringify(av, null, 2));

    check('Edge 支持 sidePanel API', av.hasSidePanel === true);
    check('Edge 支持 sidePanel.open', av.hasOpen === true);
    check('Edge 支持 setOptions', av.hasSetOptions === true);
    check('Edge 支持 setPanelBehavior', av.hasSetPanelBehavior === true);
    check('openPanelOnActionClick 已关闭',
      av.behavior && av.behavior.openPanelOnActionClick === false,
      JSON.stringify(av.behavior));
    check('DNR 规则在 Edge 中启用',
      Array.isArray(av.rules) && av.rules.includes('deepseek_frame_rules'),
      (av.rules || []).join(','));
    check('action.onClicked 监听器存在', av.hasOnClicked === true);

    sw.close();
  }

  // ---- 5. 打开 panel 验证渲染 ----
  console.log('\n=== 5. 验证面板渲染 ===');
  const tab = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`chrome-extension://${extId}/panel.html`)}`,
    { method: 'PUT' }
  )).json();

  const p = new CDP(tab.webSocketDebuggerUrl);
  await p.connect();
  await p.send('Page.enable');
  await p.send('Runtime.enable');
  await sleep(2000);

  const panelInfo = await p.send('Runtime.evaluate', {
    expression: `({
      href: location.href,
      hasFrame: !!document.getElementById('frame'),
      frameSrc: document.getElementById('frame')?.src,
      hasLoading: !!document.getElementById('loading'),
    })`,
    returnByValue: true,
  });
  const pi = panelInfo.result.value;
  check('面板页面在 Edge 中渲染', pi.hasFrame === true, pi.frameSrc);

  // ---- 6. 等待 DeepSeek 加载 ----
  console.log('\n=== 6. 等待 DeepSeek 加载（16s）===');
  await sleep(16000);

  const dsList = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const dsTarget = dsList.find((t) => (t.url || '').includes('deepseek'));
  check('DeepSeek iframe 在 Edge 中加载', !!dsTarget,
    dsTarget ? dsTarget.url : '未找到');

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
    check('Edge 中 sessionStorage 可访问', dv.sessionStorage === 'OK', dv.sessionStorage);
    check('Edge 中 React 已挂载', dv.rootChildren > 0, `root 子节点 ${dv.rootChildren}`);
    check('Edge 中页面有内容', dv.bodyTextLen > 0, `${dv.bodyTextLen} 字符`);
    d.close();
  }

  // ---- 汇总 ----
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log('\n' + '='.repeat(60));
  console.log(`Edge 验证结果：${passed}/${total} 通过`);
  console.log('='.repeat(60));
  results.forEach((r) => console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}`));

  b.close(); p.close();
  try { child.kill(); } catch {}
  await sleep(1500);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
  process.exit(passed === total ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
