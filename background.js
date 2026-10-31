// background.js — Service Worker
//
// 目标：点击工具栏图标，只在【当前标签页】打开侧边栏。
//
// ============================================================
// 关键 bug 修复记录（v2.2.0）
// ============================================================
// 上一版这样写，点击无任何反应：
//
//   chrome.action.onClicked.addListener(async (tab) => {
//     await chrome.sidePanel.setOptions({ tabId: tab.id, ... });  // ← await 打断手势
//     await chrome.sidePanel.open({ tabId: tab.id });             // ← 抛错，静默失败
//   });
//
// 报错：`sidePanel.open()` may only be called in response to a user gesture.
//
// 原因：open() 必须「紧贴」用户手势同步调用。中间任何 await 都会产生
// 异步间隙，Chrome 不再认为这是用户触发的，于是拒绝。
//
// 正确做法：
//   · 在【事件处理器外部】提前把每个标签页的面板配置好
//   · onClicked 里【同步】调用 open({tabId})，不 await 任何东西
// ============================================================
//
// 为什么不能只靠 manifest：
//   · 声明 side_panel.default_path → 全局面板，切换标签页仍然存在
//   · 不声明 → 必须自己用 tabId 配置，才能做到「只在这个标签页」

// ============================================================
// 说明：本扩展不需要 "tabs" 权限
// ============================================================
// chrome.tabs 的以下能力不需要 "tabs" 权限：
//   · tabs.query / onActivated / onUpdated / onRemoved
//   · tab.id（用于 sidePanel.setOptions 的 tabId）
// 只有读取 tab.url / tab.title / tab.favIconUrl 才需要 "tabs"。
// 本扩展不读这些字段，所以不申请 —— Edge 审核要求「不请求不必要的权限」。

const PANEL_PATH = 'panel.html';

// ============================================================
// 一、预配置：为标签页准备好面板
// ============================================================
// 这些操作发生在【非点击事件】里，异步完全没问题。
// 目的是让 onClicked 里不需要任何 await。

async function configureTab(tabId) {
  // tabId 必须是有效正整数；-1（TAB_ID_NONE）表示无标签页
  if (typeof tabId !== 'number' || tabId < 0) return;
  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: PANEL_PATH,
      enabled: true,
    });
  } catch (e) {
    // 标签页可能已关闭，忽略
  }
}

async function configureAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((t) => configureTab(t.id)));
  } catch (e) {
    console.warn('[DS] 预配置全部标签页失败:', e.message);
  }
}

// 标签页激活 / 加载时预配置（用户切过去之前就准备好）
chrome.tabs.onActivated.addListener(({ tabId }) => {
  configureTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    configureTab(tabId);
  }
});

// ============================================================
// 二、点击图标：同步 open，不 await
// ============================================================

chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id === undefined) return;

  // 【重要】这一行之前不能有任何 await / async
  // open() 依赖当前调用栈仍处于用户手势上下文
  chrome.sidePanel
    .open({ tabId: tab.id })
    .then(() => {
      console.log('[DS] 侧边栏已打开，tabId =', tab.id);
    })
    .catch((e) => {
      console.warn('[DS] open 失败:', e.message);
      // 兜底：极少情况下面板还没配置好，配置一次再让用户点
      configureTab(tab.id);
    });
});

// ============================================================
// 三、清理：标签页关闭
// ============================================================

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    await chrome.sidePanel.setOptions({ tabId, enabled: false });
  } catch (e) {
    // 标签页已销毁，正常情况
  }
});

// ============================================================
// 四、启动 / 安装
// ============================================================

async function ensurePanelBehavior() {
  try {
    // 关闭内置「点击图标开全局面板」，改由上面 onClicked 控制 tabId
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (e) {
    console.warn('[DS] setPanelBehavior 失败:', e.message);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensurePanelBehavior();
  await configureAllTabs();
  await diagnoseRules();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensurePanelBehavior();
  await configureAllTabs();
});

// Service Worker 每次唤醒
ensurePanelBehavior();
configureAllTabs();

// ============================================================
// 五、DNR 规则自检
// ============================================================

async function diagnoseRules() {
  try {
    const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
    if (enabled.includes('deepseek_frame_rules')) {
      console.log('[DS] ✅ 规则集已启用');
    } else {
      console.error(
        '[DS] ❌ 规则集 deepseek_frame_rules 未启用！\n' +
        '  可能原因：rules.json 语法错误，或 manifest 路径不对。\n' +
        '  请到 chrome://extensions → 本扩展 → 「错误」查看详情。'
      );
    }
  } catch (e) {
    console.error('[DS] 诊断异常:', e);
  }
}
