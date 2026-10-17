# IMA 文档批量下载工具

一个基于 Chrome Extension Manifest V3 的浏览器扩展，用于批量下载腾讯 [IMA 知识库](https://ima.qq.com) 中的文档，支持保持知识库原有的目录层级、选择保存位置、暂停/恢复/取消下载，并自动处理文件名非法字符。

> 本工具仅供个人学习、研究及备份使用，请勿用于商业用途。详见文末「免责声明」。

## 功能特性

- ✅ **登录态自动获取**：从 IMA 页面 `localStorage` 读取账号信息，Content Script 注入 + `chrome.scripting` 双通道兜底
- ✅ **知识库列表加载**：获取个人/团队知识库，展示名称、成员数、更新时间
- ✅ **递归扫描目录**：BFS 广度优先遍历知识库文件夹结构，支持分页游标
- ✅ **扫描结果缓存**：扫描结果精简后存入 `chrome.storage.local`，二次打开免扫描，可一键清除缓存
- ✅ **树形文件列表**：按目录层级展示，支持文件夹折叠/展开、全选、按文件夹勾选、仅下载选中子集
- ✅ **任意目录写入（文件系统访问 API）**：通过 `showDirectoryPicker` 选择保存位置，直接写入所选文件夹并**保持知识库目录层级**
- ✅ **加密下载接口**：AES-GCM + RSA-OAEP 混合加密调用 `get_media` 接口，兼容 IMA 安全校验
- ✅ **外部链接抓取**：微信公众号文章等外部链接内容可直接抓取保存为 HTML/TXT 或原始二进制
- ✅ **进度实时显示**：扫描进度、下载进度、失败数实时刷新
- ✅ **下载控制**：暂停 / 恢复 / 取消下载，支持并发数（默认 3）
- ✅ **文件名安全处理**：清理 Windows/Chrome 非法字符、零宽字符、保留名（CON/PRN/NUL 等）、超长截断
- ✅ **免责声明门槛**：首次使用需勾选同意使用须知

## 目录结构

```
sea_ima_tool/
├── manifest.json          # 扩展清单（MV3 配置、权限、图标）
├── background.js          # 后台 Service Worker（核心逻辑：鉴权、扫描、加密、下载调度）
├── content.js             # 内容脚本（注入 ima.qq.com，读取登录态）
├── offscreen.html         # 离屏文档（窗口上下文，执行真实文件写入/下载）
├── offscreen.js           # 离屏文档逻辑（File System Access 写入 + blob 下载）
├── popup.html             # 主界面（独立弹窗）
├── popup.css              # 主界面样式
├── popup.js               # 主界面交互逻辑
├── disclaimer.html        # 免责声明页
├── disclaimer.css         # 免责声明样式
├── disclaimer.js          # 免责声明逻辑（同意后跳转主界面）
└── icons/                 # 扩展图标
    ├── icon_sima.png      # 实际使用的 PNG 图标
    └── icon.svg           # SVG 图标源文件
```

## 安装方法

1. 打开 Chrome 浏览器，进入扩展管理页面：地址栏输入 `chrome://extensions/`
2. 开启右上角的「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目文件夹（即 `sea_ima_tool` 目录）
5. 安装完成后，工具栏会出现扩展图标，点击图标会打开独立弹窗

## 使用方法

1. 访问 [https://ima.qq.com](https://ima.qq.com) 并使用微信扫码登录
2. 点击工具栏中的扩展图标，打开工具弹窗
3. 首次使用会弹出「免责声明」，勾选同意后进入主界面
4. 主界面会显示登录状态（已登录 / 未登录）
5. 点击「加载知识库列表」，选择要下载的知识库
6. 点击「扫描文件」，等待 BFS 递归扫描完成（会自动缓存扫描结果）
7. 在树形列表中勾选需要下载的文件（默认全选）
8. 点击「保存位置」输入框，通过系统对话框选择文件夹（文件将直接写入该文件夹，并保持知识库目录层级）
9. 点击「开始下载」，等待完成

## 核心实现原理

### 1. 登录态获取（`content.js` / `background.js`）

Content Script 注入到 `ima.qq.com`，从页面 `localStorage` 读取 `ima-universal-local-storage-accountInfo`，提取 `guid`、`refreshToken`、`token`、`uid`。若 Content Script 未注入，`background.js` 会通过 `chrome.scripting.executeScript` 兜底读取。

```javascript
// content.js
const data = localStorage.getItem("ima-universal-local-storage-accountInfo");
const parsed = JSON.parse(data);
return {
  guid: parsed.guid,
  refreshToken: parsed.refreshToken,
  token: parsed.token,
  uid: parsed.uid
};
```

### 2. 请求头构造与 bkn

基于账号信息构造 IMA 请求所需的 `x-ima-cookie`、`x-ima-bkn`（CSRF token）等请求头（见 `background.js` 中的 `prepareHeaders` / `getBkn`）。

### 3. 知识库扫描（BFS + 分页）

`collectAllFiles` 使用广度优先遍历，每批并发 5 个文件夹，每个文件夹内通过 `get_knowledge_list` 接口按 `cursor` 游标分页拉取，递归获取全部文件与文件夹，同时维护 `folderSegments` 数组以精确记录目录层级。

```javascript
const queue = [{ folderId: knowledgeBaseId, pathSegments: [] }];
while (queue.length > 0) {
  const batch = queue.splice(0, 5);
  // ... 并发拉取 + 分页 ...
}
```

### 4. 加密下载接口（AES-GCM + RSA-OAEP）

`get_media` 接口需要加密请求体，`encryptRequestBody` 实现混合加密：生成随机 AES-GCM 密钥加密 JSON 请求体，再用内置 RSA 公钥（RSA-OAEP）加密 AES 密钥。AES 密钥加密结果通过 `x-ima-ckey` 请求头传递，响应体再用同一 AES 密钥解密。

```javascript
async function encryptRequestBody(data) {
  const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["encrypt", "decrypt"]);
  // ... AES-GCM 加密 data ...
  const encryptedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsaKey, aesKeyRaw);
  return { aesKey, body, encryptedKey };
}
```

### 5. 文件写入与下载（Offscreen Document）

MV3 的 Service Worker 没有 `FileSystemDirectoryHandle`、`URL.createObjectURL` 等窗口上下文能力，因此真实写入/下载交由 Offscreen Document（`offscreen.html` / `offscreen.js`）完成：

- 优先通过 File System Access API 把内容直接写入用户选择的文件夹（目录结构 = 知识库层级）
- 未选择文件夹时，回退使用 `chrome.downloads` + blob URL 下载，避免服务器 `Content-Disposition` 改写文件名

#### 保存目录句柄持久化

`FileSystemDirectoryHandle` 无法被 `chrome.storage` 序列化，因此使用 IndexedDB（数据库 `ima_tool_fs`，对象仓库 `kv`，键 `saveDirHandle`）持久化，供离屏文档重启后恢复。

### 6. 文件名安全处理

`background.js` 中的 `sanitizeFileName` / `sanitizeFileNameAsync` 完整处理文件名安全问题：

- 移除零宽字符、控制字符
- 替换 Windows/Chrome 非法字符（`:` → `ː`、`/` → `_`、`*` → `_` 等）
- 字符白名单过滤（ASCII 可打印、CJK 汉字/标点、全角 ASCII）
- 处理 Windows 保留名（`CON`、`PRN`、`AUX`、`NUL`、`COM1-9`、`LPT1-9`）
- 超长文件名截断（保留扩展名）

### 7. 外部链接抓取

对于非 IMA 自身的链接（如微信公众号文章），`fetchExternalContent` 会直接抓取内容：HTML 内容保存为 `.html`，二进制内容转为 `data:` URL 保存原始格式；抓取失败时降级为 `.txt` 链接备忘文件。

## 消息协议说明

弹窗（`popup.js`）与后台（`background.js`）通过 `chrome.runtime.sendMessage` 通信，主要消息类型：

| 消息类型 | 说明 |
| --- | --- |
| `GET_ACCOUNT_INFO` | 获取登录态 |
| `GET_KNOWLEDGE_BASE_LIST` | 加载知识库列表 |
| `COLLECT_FILES` | 扫描知识库文件 |
| `CLEAR_SCAN_CACHE` | 清除扫描缓存 |
| `BATCH_DOWNLOAD` | 批量下载 |
| `PAUSE_DOWNLOAD` / `RESUME_DOWNLOAD` / `CANCEL_DOWNLOAD` | 下载控制 |
| `COLLECT_PROGRESS` / `DOWNLOAD_PROGRESS` | 进度推送（后台 → 弹窗） |
| `OFFSCREEN_DOWNLOAD_FILE` | 离屏文档下载/写入（后台 → 离屏） |

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 访问当前 IMA 标签页 |
| `downloads` | 回退下载到浏览器下载目录 |
| `storage` / `unlimitedStorage` | 存储扫描缓存、免责声明状态 |
| `scripting` | 未注入 Content Script 时兜底读取登录态 |
| `offscreen` | 创建离屏文档执行文件写入 |
| 主机权限 | 访问 `ima.qq.com` 及外部链接内容 |

## 技术栈

- **Chrome Extension Manifest V3**（Service Worker + Offscreen Document）
- **原生 JavaScript**（无框架依赖）
- Chrome Extensions API
  - `chrome.downloads` — 回退文件下载
  - `chrome.storage` — 数据缓存
  - `chrome.scripting` — 脚本注入兜底
  - `chrome.offscreen` — 离屏文档
  - `chrome.runtime` / `chrome.tabs` / `chrome.windows` — 消息通信与窗口管理
- **Web Crypto API** — AES-GCM / RSA-OAEP 加密
- **File System Access API** — `showDirectoryPicker` 选择目录、目录句柄写入
- **IndexedDB** — 持久化目录句柄

## 注意事项

1. **登录态有效期**：IMA 登录态会过期，遇到错误请重新登录 [ima.qq.com](https://ima.qq.com) 后点击「刷新状态」
2. **下载频率**：建议使用默认并发数（3），避免触发接口限流
3. **文件名处理**：自动替换 Windows 非法字符（`:` `?` `*` `<` `>` `|` `\` 等）
4. **存储空间**：确保目标磁盘有足够空间
5. **目录句柄失效**：浏览器重启后，若写入失败提示「未找到已授权的保存目录」，请在弹窗中重新选择保存位置

## 故障排除

| 问题 | 解决 |
| --- | --- |
| 提示「未找到账号信息」 | 确保已登录 ima.qq.com，然后点击「刷新状态」 |
| 下载失败 | 检查网络、IMA 登录状态，查看日志区域错误信息 |
| 扫描文件数为 0 | 确认知识库中有文件，并检查知识库权限 |
| 文件被保存为「下载.pdf」 | 属服务端 `Content-Disposition` 覆盖，本工具已通过 blob URL / 文件系统写入规避；如仍复现请查看 Service Worker 控制台日志（`[路径]` 相关输出） |
| 写入所选文件夹失败 | 重新点击「保存位置」选择文件夹，重新授权读写权限 |
| 点击扩展图标无反应 / 弹窗失效 | 关闭旧弹窗后重新点击图标（扩展会复用现有窗口并聚焦） |

## 许可证

MIT License

## 免责声明

本工具仅供个人学习、研究及技术交流使用，用于导出您在 IMA 平台上拥有合法访问权限的知识库内容，便于离线阅读和备份。禁止用于商业用途、非法传播或侵犯他人知识产权。使用本工具产生的任何问题及后果由用户自行承担，开发者不对使用导致的直接或间接损失、账号封禁或数据用途后果负责。继续使用即表示您已完全理解并同意上述条款。