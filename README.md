# DeepSeek 侧边栏

把 DeepSeek 网页端原样放进浏览器侧边栏。**只在点击的那个标签页显示**。

同时兼容 Chrome 和 Microsoft Edge（116+）。

> 本扩展是非官方第三方项目，与杭州深度求索人工智能基础技术研究有限公司（DeepSeek）无任何关联。
> 「DeepSeek」名称与鲸鱼图标归其所有者所有，本项目仅在侧边栏中加载 DeepSeek 官方网页，不修改其内容。

---

## 下载安装

从 [Releases](https://github.com/Foundnova/ds-sidepanel/releases/latest) 下载最新的
`deepseek-sidebar-v*.zip`，解压后：

- **Chrome**：`chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选解压出来的目录
- **Edge**：`edge://extensions` → 打开「开发人员模式」→「加载解压缩的扩展」→ 选解压出来的目录

---

## 上传到 Edge 商店

**打包产物**：`dist/deepseek-sidebar-v2.4.0.zip`（16.3 KB，9 个文件）

上传地址：<https://partner.microsoft.com/dashboard/microsoftedge/>

直接把这个 zip 拖到「Upload package」区域即可。

重新打包：

```bash
node build-zip.js
```

### 图标

使用 **DeepSeek 官方鲸鱼标志**，从 `chat.deepseek.com` 拉取原始资源：

| 来源 | 用途 |
|---|---|
| `https://fe-static.deepseek.com/chat/icon-512.png` | 主图标（512×512 官方资源） |

`make-icons.js` 用**面积平均**算法（预乘 alpha，避免透明边缘发黑）
缩放出 16/32/48/128/256/512 六种尺寸：

```bash
node make-icons.js
```

原始资源保存在 `official-icons/` 目录（不打包）。

### Edge 打包的硬性要求（都已处理）

| 要求 | 处理 |
|---|---|
| **不能含 `key` 字段** | 已从 manifest 移除。Edge 会直接拒绝含 `key` 的包 |
| **必须含 128×128 图标** | 官方鲸鱼图标，6 种尺寸 |
| **zip 根目录必须是 manifest.json** | 已验证：9 个条目全部在根，无嵌套目录 |
| **不能含压缩过的文件** | zip 用 store 模式（不压缩内部条目） |

另外，测试脚本（`verify*.js`）、`README.md`、`build-zip.js`、`make-icons.js`、
`official-icons/`、Chrome 生成的 `_metadata/` 缓存目录都**不会**被打进包里。

### zip 内容清单

```
manifest.json                976 bytes
background.js              5,698 bytes
panel.html                 2,222 bytes
panel.js                   1,322 bytes
rules.json                   541 bytes
icons/icon16.png             358 bytes
icons/icon32.png             712 bytes
icons/icon48.png           1,075 bytes
icons/icon128.png          2,820 bytes
─────────────────────────────────────
9 files                   15,724 bytes
```

SHA256：`97670B06E899E3F9095A8AA5BD627F7E1D7F522F56C54638042643F82BE9F632`

---

## 验证状态

### 在真实 Microsoft Edge 155 中

```
Edge 验证结果：18/18 通过
```

关键结果：

```
Edge: Edg/155.0.4283.62
扩展加载成功 → aophdfefbnmpciohbaipnhacmlphcfle
Edge 支持 sidePanel API        ✅
Edge 支持 sidePanel.open       ✅
Edge 支持 setOptions           ✅
Edge 支持 setPanelBehavior     ✅
DNR 规则在 Edge 中启用          ✅ deepseek_frame_rules
面板页面在 Edge 中渲染          ✅
DeepSeek iframe 在 Edge 中加载  ✅
Edge 中 sessionStorage 可访问   ✅ OK
Edge 中 React 已挂载            ✅
```

验证方式不是「看一眼能跑」，而是：**解压 zip → 用 `msedge.exe` 加载 → 检查
Service Worker、API 可用性、iframe 真实渲染**。

### 在 Chrome 155 中

```
verify.js              27/27 通过
verify-tab-scope.js    19/19 通过
verify-click.js        18/18 通过
verify-open-state.js    5/5 通过
─────────────────────────────────
                       69/69 通过
```

自测命令：

```bash
node make-icons.js        # 从官方图标生成各尺寸（已生成，一般不需要重跑）
node build-zip.js         # 打包
node verify-edge.js       # 在真实 Edge 中验证 zip
node verify.js            # Chrome 基础功能
node verify-tab-scope.js  # 标签页隔离
node verify-click.js      # 点击打开
node verify-open-state.js # 预配置≠显示
```

浏览器不在默认安装位置时，用环境变量指定可执行文件路径：

```bash
# Windows PowerShell
$env:CHROME_PATH="D:\Chrome\chrome.exe"; node verify.js
$env:EDGE_PATH="D:\Edge\msedge.exe";    node verify-edge.js

# macOS / Linux
CHROME_PATH="/usr/bin/chromium" node verify.js
EDGE_PATH="/usr/bin/microsoft-edge" node verify-edge.js
```

脚本会按 `环境变量 → 平台默认安装路径` 顺序探测，Windows 默认路径与之前一致。

---

## 本地安装（开发调试）

- **Chrome**：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选本目录
- **Edge**：`edge://extensions` → 开发人员模式 → 加载解压缩的扩展 → 选本目录

---

## 行为

1. 在标签页 A 点扩展图标 → **只有 A 显示侧边栏**
2. 切到标签页 B → **没有侧边栏**
3. 在 B 点图标 → B 也有了，A 的仍保留（各自独立）
4. 关闭标签页 → 该标签页的面板状态自动清理

侧边栏里就是 `chat.deepseek.com` 原样页面，登录态自动继承。

---

## 核心机制

### 三个必须同时满足的条件

**1. manifest 里不能声明 `side_panel.default_path`**

```json
// ❌ 一旦声明就是全局面板，跨标签页仍存在
"side_panel": { "default_path": "panel.html" }
```

**2. 关闭内置的「点击图标开面板」**

```js
await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
```

**3. 用 `tabId` 而不是 `windowId`**

```js
await chrome.sidePanel.open({ tabId: tab.id });   // 标签页专属
//                            ↑ windowId 是全局面板
```

### 关键陷阱：`open()` 前不能有 `await`

这是 v2.1「点击无反应」的根因：

```js
// ❌ 错误：点击完全没反应
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.setOptions({ tabId: tab.id, path: 'panel.html', enabled: true });
  await chrome.sidePanel.open({ tabId: tab.id });   // 抛错，被 catch 吞掉
});
```

实测报错：

```
`sidePanel.open()` may only be called in response to a user gesture.
```

**原因**：`open()` 必须紧贴用户手势**同步**调用。中间任何 `await` 都会产生
异步间隙，Chrome 不再认为这是用户触发的。

**正确写法**：

```js
// ✅ 预配置在事件处理器外部完成
chrome.tabs.onActivated.addListener(({ tabId }) => configureTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status || info.url) configureTab(tabId);
});

// ✅ 点击处理器是同步的，open() 之前没有任何 await
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id }).catch((e) => {
    console.warn('[DS] open 失败:', e.message);
    configureTab(tab.id);
  });
});
```

### 预配置 ≠ 显示

修复点击问题后，所有标签页都会被 `setOptions` 预配置。
**这不会导致所有标签页都显示侧边栏**：

- `setOptions({enabled: true, path})` 只配置「面板内容是什么」
- 只有 `open({tabId})` 才真正显示

`verify-open-state.js` 验证了这一点：预配置后无手势调用 `open()` 仍抛
「需要用户手势」错误，证明面板并未自动打开。

---

## 两个不能删的技术点

### 1. DNR 删掉 `frame-ancestors 'none'`

DeepSeek 响应头有 `content-security-policy: frame-ancestors 'none'`，
不删的话 iframe 直接白屏。

```json
"condition": {
  "urlFilter": "||chat.deepseek.com^",
  "resourceTypes": ["sub_frame"]
}
```

`resourceTypes` 必须是 **`sub_frame`**。

### 2. 宿主必须是 `chrome-extension://` 起源

普通网页里嵌 DeepSeek 会崩：

```
SecurityError: Failed to read the 'sessionStorage' property from 'Window':
Access is denied for this document.
```

| 宿主 | sessionStorage | React 渲染 |
|---|---|---|
| `about:blank` | ❌ SecurityError | ❌ root 为空 |
| `chrome-extension://` | ✅ OK | ✅ 正常渲染 |

扩展页起源下第三方存储不被隔离，登录态天然继承，不需要 cookie 同步。

---

## 文件

### 打包进 zip 的（9 个）

| 文件 | 作用 | 大小 |
|---|---|---|
| `manifest.json` | MV3 清单 | 976 B |
| `background.js` | 按标签页开面板 + 预配置 + 清理 | 5.6 KB |
| `panel.html` | 侧边栏 UI（iframe + 加载态 + 错误提示） | 2.2 KB |
| `panel.js` | 加载状态管理 | 1.3 KB |
| `rules.json` | DNR 规则：删 CSP 响应头 | 541 B |
| `icons/*.png` | 16/32/48/128 图标 | 4.8 KB |

### 不打包的（开发/测试用）

| 文件 | 作用 |
|---|---|
| `build-zip.js` | 打包脚本（含上传前检查） |
| `make-icons.js` | 从官方图标生成各尺寸（自带 PNG 解码/缩放/编码） |
| `official-icons/` | DeepSeek 官方图标原始资源 |
| `verify.js` | Chrome 基础功能验证（27 项） |
| `verify-tab-scope.js` | 标签页隔离验证（19 项） |
| `verify-click.js` | 点击打开验证（18 项，另有 1 项需真实用户激活才能跑） |
| `verify-open-state.js` | 预配置≠显示（5 项） |
| `verify-edge.js` | 真实 Edge 验证 zip（18 项） |
| `test-no-tabs-perm.js` | 移除 `tabs` 权限后的功能回归（13 项） |
| `README.md` | 本文档 |
| `_metadata/` | Chrome 自动生成的 DNR 缓存，**不要**打包，已在 `.gitignore` 中忽略 |

---

## 排查

### 点击图标没反应

`edge://extensions` 或 `chrome://extensions` → 本扩展 →
点 **Service Worker** → 控制台看：

- `[DS] open 失败: ... may only be called in response to a user gesture`
  → `open()` 前有 `await`
- `[DS] 侧边栏已打开，tabId = ...`
  → 打开成功了，若视觉上没出现，尝试调整窗口宽度

### 切到别的标签页侧边栏还在

说明还是全局面板。Service Worker 控制台执行：

```js
chrome.sidePanel.getOptions({}).then(console.log)
```

若返回 `{path: 'panel.html'}` → 有全局配置残留。

### 侧边栏空白

1. 扩展详情页点 **「错误」**，看 `rules.json` 是否报错
2. `rules.json` 语法错误会导致整个规则集被静默忽略

---

## Edge 商店提交注意事项

除了 zip 本身，Edge 商店还需在网页上填：

- **Display name**（必需，至少一种语言）
- **Description**（必需）
- **Category**（必需）
- **Store logo**（300×300 推荐，1:1；可用 `icons/icon128.png` 放大）
- **Privacy policy URL**（若声明收集数据则必需）

本扩展**不收集任何数据**，权限仅 `sidePanel` + `declarativeNetRequest`（**不含 `tabs`**），
`host_permissions` 仅 `chat.deepseek.com`。审核时应能通过。

可能的审核关注点：扩展把第三方网站嵌入侧边栏。
建议在商店描述里说明「本扩展仅在侧边栏中显示 DeepSeek 官方网页，不修改其内容」。

---

## 已知限制

- **依赖 DNR 删 CSP**：DeepSeek 若改用其他防嵌入手段需重新适配
- **侧边栏宽度**：浏览器限制，约 320–600px（DeepSeek 自动切移动版布局）
- **无法用 CDP 模拟真实工具栏点击**：工具栏图标不在调试协议范围内，
  验证的是机制层面（手势安全检查 + 预配置状态 + 真实用户激活下 open 成功）
