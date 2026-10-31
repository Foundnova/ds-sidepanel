// verify-click.js — 验证点击能否打开侧边栏（修复后）
//
// CDP 无法点击工具栏图标，但可以验证两件事：
//   1. onClicked 处理器里 open() 之前没有 await（静态检查，决定手势是否保留）
//   2. 标签页是否已被预配置（这样 open 不需要等 setOptions）
//
// 另外用 CDP Input.dispatchMouseEvent 在扩展页面里制造「用户激活」，
// 尝试真实调用 open() 观察是否成功。

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
const PORT = 9511;

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
  const userDataDir = path.join(os.tmpdir(), 'ds-click-' + Date.now());
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

  // ============================================================
  // 1. 静态检查：onClicked 里没有 await
  // ============================================================
  console.log('\n=== 1. 手势安全静态检查 ===');
  const bgSrc = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');

  // 精确截取 onClicked 处理器的函数体（按大括号配对）
  // 注意：源码注释里也有 "chrome.action.onClicked.addListener" 字样，
  // 必须跳过注释行，否则会匹配到注释里的旧版代码。
  function findRealHandlerStart(src, marker) {
    const lines = src.split('\n');
    let offset = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      const isComment = trimmed.startsWith('//') ||
                        trimmed.startsWith('*') ||
                        trimmed.startsWith('/*');
      if (!isComment && line.includes(marker)) {
        return { lineIdx: lines.indexOf(line), offset: offset + line.indexOf(marker) };
      }
      offset += line.length + 1;
    }
    return null;
  }

  function extractHandlerBody(src, marker) {
    const found = findRealHandlerStart(src, marker);
    if (!found) return '';
    const braceStart = src.indexOf('{', found.offset);
    if (braceStart < 0) return '';
    let depth = 0;
    for (let i = braceStart; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) return src.slice(braceStart + 1, i);
      }
    }
    return '';
  }

  const onClickedMarker = 'chrome.action.onClicked.addListener';
  const foundHandler = findRealHandlerStart(bgSrc, onClickedMarker);
  const handlerBody = extractHandlerBody(bgSrc, onClickedMarker);
  const handlerDecl = foundHandler
    ? bgSrc.slice(foundHandler.offset, foundHandler.offset + 60).split('\n')[0]
    : '(未找到)';

  console.log('  处理器声明:', handlerDecl.trim());
  check('找到真实的 onClicked 处理器（非注释）',
    !!foundHandler && !handlerDecl.trim().startsWith('//'),
    handlerDecl.trim());

  check('onClicked 处理器非 async',
    !/addListener\(\s*async/.test(handlerDecl),
    /addListener\(\s*async/.test(handlerDecl) ? '仍是 async（危险）' : '同步函数');

  // 剔除注释行后再做 await 检查（注释里出现 "await" 字样不算）
  const codeOnly = handlerBody
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))       // 去掉行尾注释
    .join('\n');

  check('onClicked 内无 await（仅检查代码）', !/\bawait\s/.test(codeOnly),
    /\bawait\s/.test(codeOnly) ? '发现 await（会打断手势）' : '无 await');

  check('onClicked 内无 setOptions', !/setOptions/.test(codeOnly),
    /setOptions/.test(codeOnly) ? '调用了 setOptions（危险）' : '未调用');

  const openIdx = handlerBody.indexOf('sidePanel');
  const openCallIdx = handlerBody.indexOf('.open(');
  check('onClicked 直接调用 open()',
    openCallIdx > -1,
    openCallIdx > -1 ? `位置 ${openCallIdx}` : '未找到 open 调用');

  check('open 使用 tabId（非 windowId）',
    /open\(\s*\{\s*tabId/.test(handlerBody),
    'tabId' );

  // 预配置函数存在
  check('存在 configureTab 预配置函数', /function configureTab/.test(bgSrc));
  check('监听 tabs.onActivated 预配置', /tabs\.onActivated\.addListener/.test(bgSrc));
  check('监听 tabs.onUpdated 预配置', /tabs\.onUpdated\.addListener/.test(bgSrc));

  // ============================================================
  // 2. API 状态
  // ============================================================
  console.log('\n=== 2. API 状态 ===');
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const swTarget = list.find((t) => t.type === 'service_worker' && (t.url || '').includes(extId));
  check('Service Worker 存在', !!swTarget);

  const sw = new CDP(swTarget.webSocketDebuggerUrl);
  await sw.connect();
  await sw.send('Runtime.enable');

  const behavior = await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.getPanelBehavior()`,
    awaitPromise: true,
    returnByValue: true,
  });
  check('openPanelOnActionClick 已关闭',
    behavior.result.value.openPanelOnActionClick === false,
    JSON.stringify(behavior.result.value));

  const globalOpts = await sw.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.getOptions({})`,
    awaitPromise: true,
    returnByValue: true,
  });
  check('无全局面板配置',
    !globalOpts.result.value.path,
    `path=${globalOpts.result.value.path || '(空)'}`);

  // ============================================================
  // 3. 标签页是否已被预配置
  // ============================================================
  console.log('\n=== 3. 标签页预配置 ===');
  await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('https://example.com/?pre=A')}`,
    { method: 'PUT' }
  )).json();
  await sleep(2500);   // 等 onActivated/onUpdated 触发预配置

  const tabsRes = await sw.send('Runtime.evaluate', {
    expression: `chrome.tabs.query({}).then(ts => ts.map(t => ({id:t.id, active:t.active, url:t.url||''})))`,
    awaitPromise: true,
    returnByValue: true,
  });
  const tabs = tabsRes.result.value || [];
  // 注意：本扩展不含 "tabs" 权限，tab.url 已被剥离。
  // 用「最后一个创建的标签页」定位（就是刚打开的测试页）。
  const tA = tabs[tabs.length - 1];
  check('找到测试标签页（最后创建）', !!tA, tA ? `id=${tA.id}` : '');
  check('URL 已被剥离（证明无 tabs 权限）', !tA || !tA.url,
    tA ? `url="${tA.url}"` : '');

  if (tA) {
    const opts = await sw.send('Runtime.evaluate', {
      expression: `chrome.sidePanel.getOptions({ tabId: ${tA.id} })`,
      awaitPromise: true,
      returnByValue: true,
    });
    const o = opts.result.value;
    check('标签页已预配置（path + enabled）',
      o.path === 'panel.html' && o.enabled === true,
      `path=${o.path}, enabled=${o.enabled}`);

    // ============================================================
    // 4. 真实用户激活下调用 open
    // ============================================================
    console.log('\n=== 4. 尝试真实打开 ===');
    // 先打开扩展页面，用 CDP 模拟点击产生用户激活
    const panelTab = await (await fetch(
      `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`chrome-extension://${extId}/panel.html`)}`,
      { method: 'PUT' }
    )).json();
    const pt = new CDP(panelTab.webSocketDebuggerUrl);
    await pt.connect();
    await pt.send('Page.enable');
    await pt.send('Runtime.enable');
    await sleep(1500);

    // 用 CDP 派发真实鼠标事件产生用户激活
    await pt.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: 100, y: 100, button: 'left', clickCount: 1,
    });
    await pt.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: 100, y: 100, button: 'left', clickCount: 1,
    });
    await sleep(300);

    const openTry = await pt.send('Runtime.evaluate', {
      expression: `chrome.sidePanel.open({ tabId: ${tA.id} })
        .then(() => 'OK')
        .catch(e => 'ERR: ' + e.message)`,
      awaitPromise: true,
      returnByValue: true,
    });
    console.log('  open 结果:', openTry.result.value);
    // 从这里调用仍可能因跨上下文拿不到手势，不算失败
    if (openTry.result.value === 'OK') {
      check('用户激活下 open 成功', true, 'OK');
    } else {
      console.log('    （从扩展页发起不算工具栏手势，预期会失败，不作为判定依据）');
    }

    pt.close();
  }

  // ============================================================
  // 5. manifest 检查
  // ============================================================
  console.log('\n=== 5. manifest ===');
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  check('无 side_panel 声明（按标签页）', !manifest.side_panel);
  check('permissions 不含 tabs（审核要求）', !(manifest.permissions || []).includes('tabs'), (manifest.permissions || []).join(','));
  check('permissions 含 sidePanel', (manifest.permissions || []).includes('sidePanel'));

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
