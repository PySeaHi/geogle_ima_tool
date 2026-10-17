// ============ IMA 下载工具 - Popup 界面逻辑 ============

let accountInfo = null;
let selectedKb = null;
let scannedFiles = [];
let fileTreeData = null; // 文件树数据模型，用于跟踪勾选状态
let saveDirHandle = null; // 用户选择的保存目录句柄

/**
 * 持久化目录句柄到 IndexedDB（与 background.js 共用同一数据库）
 * chrome.storage 无法序列化 FileSystemDirectoryHandle，必须用 IndexedDB
 */
function persistSaveDirHandle(handle) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("ima_tool_fs", 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("kv"); };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(handle, "saveDirHandle");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

// 页面加载完成后检查免责声明和登录状态
document.addEventListener("DOMContentLoaded", async () => {
  // 检查是否已同意免责声明
  const result = await chrome.storage.local.get("disclaimer_agreed");
  if (!result.disclaimer_agreed) {
    // 未同意，跳转到免责声明页面
    window.location.href = "disclaimer.html";
    return;
  }
  
  await checkLoginStatus();
  setupEventListeners();
});

/**
 * 检查登录状态
 */
async function checkLoginStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_ACCOUNT_INFO" });

    if (response.success && response.data) {
      accountInfo = response.data;
      showLoggedIn();
    } else {
      showLoginHint();
    }
  } catch (error) {
    console.error("检查登录状态失败:", error);
    showLoginHint();
  }
}

/**
 * 显示已登录状态
 */
function showLoggedIn() {
  const statusDot = document.getElementById("status-dot");
  statusDot.classList.remove("offline");
  statusDot.classList.add("online");
  document.getElementById("status-text").textContent = "已登录";
  document.getElementById("login-hint").classList.add("hidden");
  document.getElementById("main-content").classList.remove("hidden");
  document.getElementById("refresh-btn-main").classList.remove("hidden");
  log("已连接到 IMA", "success");
}

/**
 * 显示登录提示
 */
function showLoginHint() {
  const statusDot = document.getElementById("status-dot");
  statusDot.classList.remove("online");
  statusDot.classList.add("offline");
  document.getElementById("status-text").textContent = "未登录";
  document.getElementById("login-hint").classList.remove("hidden");
  document.getElementById("main-content").classList.add("hidden");
  document.getElementById("refresh-btn-main").classList.add("hidden");
  log("请先登录 IMA", "warn");
}

/**
 * 设置事件监听
 */
function setupEventListeners() {
  // 打开 IMA 按钮
  document.getElementById("open-ima-btn").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://ima.qq.com" });
  });

  // 刷新状态按钮（登录提示区域）
  document.getElementById("refresh-btn").addEventListener("click", async () => {
    const btn = document.getElementById("refresh-btn");
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> 检测中...';
    await checkLoginStatus();
    btn.disabled = false;
    btn.innerHTML = originalText;
  });

  // 刷新状态按钮（主界面标题栏）
  document.getElementById("refresh-btn-main").addEventListener("click", async () => {
    const btn = document.getElementById("refresh-btn-main");
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "检测中...";
    await checkLoginStatus();
    btn.disabled = false;
    btn.textContent = originalText;
  });

  // 加载知识库列表按钮
  document.getElementById("load-kb-btn").addEventListener("click", loadKnowledgeBaseList);

  // 扫描文件按钮
  document.getElementById("scan-btn").addEventListener("click", scanFiles);

  // 下载按钮
  document.getElementById("download-btn").addEventListener("click", startDownload);

  // 全部折叠/展开按钮
  document.getElementById("collapse-all-btn").addEventListener("click", toggleCollapseAll);

  // 清除缓存按钮
  document.getElementById("clear-cache-btn").addEventListener("click", clearScanCache);

  // 暂停/恢复下载按钮
  document.getElementById("pause-btn").addEventListener("click", togglePauseDownload);

  // 取消下载按钮
  document.getElementById("cancel-btn").addEventListener("click", cancelDownload);

  // 点击保存路径输入框 - 打开系统文件夹选择对话框，直接写入所选文件夹
  document.getElementById("save-path-input").addEventListener("click", async () => {
    try {
      if ('showDirectoryPicker' in window) {
        const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
        saveDirHandle = dirHandle;
        // 预授权 readwrite：默认 showDirectoryPicker 只授予 read，会导致 offscreen 里
        // getDirectoryHandle/createWritable 报 "User activation is required to request permissions"
        if (typeof dirHandle.requestPermission === "function") {
          try {
            await dirHandle.requestPermission({ mode: "readwrite" });
          } catch (e) {
            console.warn("[popup] 预授权 readwrite 失败:", e);
          }
        }
        // 持久化目录句柄，供 background service worker 写入文件
        await persistSaveDirHandle(dirHandle);
        document.getElementById("save-path-input").value = dirHandle.name;
        log(`✓ 保存位置: ${dirHandle.name}（文件将直接写入此文件夹，并保持知识库目录层级）`, "success");
      } else {
        document.getElementById("folder-picker").click();
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        log(`选择文件夹失败: ${error.message}`, "error");
        document.getElementById("folder-picker").click();
      }
    }
  });

  // 处理 webkitdirectory 选择的文件夹
  document.getElementById("folder-picker").addEventListener("change", (e) => {
    const files = e.target.files;
    if (files.length > 0) {
      // 从第一个文件的路径中提取文件夹名称
      const firstFile = files[0];
      const pathParts = firstFile.webkitRelativePath.split('/');
      const folderName = pathParts[0];
      document.getElementById("save-path-input").value = folderName;
      log(`已选择保存位置: ${folderName}（此方式仅作为下载子目录名，文件下载到浏览器下载目录）`, "success");
    }
  });

  // 清空日志按钮
  document.getElementById("clear-log-btn").addEventListener("click", () => {
    document.getElementById("log-content").innerHTML = "";
  });

  // 监听进度消息
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "COLLECT_PROGRESS") {
      updateCollectProgress(message.fileCount, message.folderCount);
    } else if (message.type === "DOWNLOAD_PROGRESS") {
      updateDownloadProgress(message);
    }
  });
}

/**
 * 加载知识库列表
 */
async function loadKnowledgeBaseList() {
  const btn = document.getElementById("load-kb-btn");
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner"></span> 加载中...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_KNOWLEDGE_BASE_LIST",
      accountInfo: accountInfo
    });

    if (!response.success) {
      throw new Error(response.error);
    }

    const kbList = response.data;
    displayKnowledgeBaseList(kbList);
    log(`✓ 加载了 ${kbList.length} 个知识库`, "success");
  } catch (error) {
    log(`✗ 加载知识库失败: ${error.message}`, "error");
    showNotification("加载失败，请重试", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

/**
 * 显示知识库列表
 */
function displayKnowledgeBaseList(kbList) {
  const container = document.getElementById("kb-list");
  container.innerHTML = "";

  if (kbList.length === 0) {
    container.innerHTML = `
      <div style="padding: 40px 20px; text-align: center;">
        <div style="font-size: 48px; margin-bottom: 12px; opacity: 0.3;">📚</div>
        <div style="color: var(--text-tertiary); font-size: 14px;">暂无知识库</div>
      </div>
    `;
  } else {
    kbList.forEach((kb) => {
      const item = document.createElement("div");
      item.className = "kb-item";
      const icon = kb.type === "personal" ? "👤" : "👥";
      item.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="font-size: 24px;">${icon}</div>
          <div style="flex: 1; min-width: 0;">
            <div class="kb-name">${escapeHtml(kb.name)}</div>
            <div class="kb-meta">
              ${kb.type === "personal" ? "个人知识库" : "团队知识库"} · 
              ${kb.memberCount} 成员 · 
              ${formatTime(kb.updateTime)}
            </div>
          </div>
          <div style="color: var(--primary-color); font-size: 18px; opacity: 0;">→</div>
        </div>
      `;

      item.addEventListener("click", () => selectKnowledgeBase(kb, item));
      item.addEventListener("mouseenter", () => {
        const arrow = item.querySelector('div[style*="opacity"]');
        if (arrow) arrow.style.opacity = "1";
      });
      item.addEventListener("mouseleave", () => {
        if (!item.classList.contains("selected")) {
          const arrow = item.querySelector('div[style*="opacity"]');
          if (arrow) arrow.style.opacity = "0";
        }
      });
      
      container.appendChild(item);
    });
  }

  container.classList.remove("hidden");
}

/**
 * 选择知识库
 */
function selectKnowledgeBase(kb, element) {
  // 移除之前的选中状态
  document.querySelectorAll(".kb-item").forEach((item) => {
    item.classList.remove("selected");
    const arrow = item.querySelector('div[style*="opacity"]');
    if (arrow) arrow.style.opacity = "0";
  });

  // 设置当前选中
  element.classList.add("selected");
  selectedKb = kb;

  // 显示箭头
  const arrow = element.querySelector('div[style*="opacity"]');
  if (arrow) arrow.style.opacity = "1";

  // 显示选中的知识库信息
  document.getElementById("selected-kb").classList.remove("hidden");
  document.getElementById("selected-kb-name").textContent = kb.name;
  document.getElementById("scan-btn").disabled = false;

  log(`✓ 已选择知识库: ${kb.name}`, "success");
  showNotification(`已选择: ${kb.name}`, "success");

  // 检查是否有缓存数据
  checkScanCache(kb.id);
}

/**
 * 检查扫描缓存
 */
async function checkScanCache(kbId) {
  try {
    const cacheKey = `scan_cache_${kbId}`;
    const cached = await chrome.storage.local.get(cacheKey);
    const clearCacheBtn = document.getElementById("clear-cache-btn");
    
    if (cached[cacheKey]) {
      const cache = cached[cacheKey];
      const cacheTime = new Date(cache.timestamp).toLocaleString("zh-CN");
      log(`✓ 发现缓存数据 (${cache.files.length} 个文件, 缓存时间: ${cacheTime})`, "info");
      log(`提示: 点击"扫描文件"将使用缓存数据，如需重新扫描请先清除缓存`, "info");
      clearCacheBtn.classList.remove("hidden");
    } else {
      log(`提示: 该知识库无缓存，将执行完整扫描`, "info");
      clearCacheBtn.classList.add("hidden");
    }
  } catch (error) {
    console.error("检查缓存失败:", error);
  }
}

/**
 * 清除扫描缓存
 */
async function clearScanCache() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "CLEAR_SCAN_CACHE"
    });

    if (response.success) {
      log(`✓ 已清除所有扫描缓存`, "success");
      showNotification("缓存已清除", "success");
    } else {
      throw new Error("清除缓存失败");
    }
  } catch (error) {
    log(`✗ 清除缓存失败: ${error.message}`, "error");
    showNotification("清除缓存失败", "error");
  }
}

/**
 * 扫描文件
 */
async function scanFiles() {
  if (!selectedKb) return;

  const btn = document.getElementById("scan-btn");
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner"></span> 扫描中...';

  const progressDiv = document.getElementById("scan-progress");
  progressDiv.classList.remove("hidden");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "COLLECT_FILES",
      accountInfo: accountInfo,
      knowledgeBaseId: selectedKb.id
    });

    if (!response.success) {
      throw new Error(response.error);
    }

    scannedFiles = response.data.files;
    const folders = response.data.folders;

    // 显示扫描结果
    document.getElementById("scan-result").classList.remove("hidden");
    document.getElementById("total-files").textContent = scannedFiles.length;
    document.getElementById("selected-files").textContent = scannedFiles.length;

    // 显示文件列表
    displayFileList(scannedFiles);

    document.getElementById("download-btn").disabled = scannedFiles.length === 0;

    log(`✓ 扫描完成: ${scannedFiles.length} 个文件, ${folders.length} 个文件夹`, "success");
    showNotification(`找到 ${scannedFiles.length} 个文件`, "success");
  } catch (error) {
    log(`✗ 扫描失败: ${error.message}`, "error");
    showNotification("扫描失败，请重试", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

/**
 * 更新收集进度
 */
function updateCollectProgress(fileCount, folderCount) {
  document.getElementById("file-count").textContent = fileCount;
  document.getElementById("folder-count").textContent = folderCount;
}

/**
 * 构建树形结构
 */
function buildFileTree(files) {
  const root = { name: "", children: {}, files: [], checked: true };

  files.forEach((file, index) => {
    let current = root;

    if (file.folderSegments && Array.isArray(file.folderSegments)) {
      // 新数据：folderSegments 只包含目录层级，不包含文件名
      for (const folderName of file.folderSegments) {
        if (!current.children[folderName]) {
          current.children[folderName] = { name: folderName, children: {}, files: [], collapsed: false, checked: true };
        }
        current = current.children[folderName];
      }
    } else {
      // 旧缓存兼容：path 包含文件名，需要排除最后一段
      const parts = (file.path || file.title).split("/").filter(Boolean);
      for (let i = 0; i < parts.length - 1; i++) {
        const folderName = parts[i];
        if (!current.children[folderName]) {
          current.children[folderName] = { name: folderName, children: {}, files: [], collapsed: false, checked: true };
        }
        current = current.children[folderName];
      }
    }

    // 添加文件到当前层
    current.files.push({ ...file, index, checked: true });
  });

  return root;
}

/**
 * 渲染树形节点（懒加载模式，只渲染1级，展开时才渲染子节点）
 */
function renderTreeNode(node, container, depth = 0) {
  // 渲染文件夹
  const folderNames = Object.keys(node.children).sort();
  for (const name of folderNames) {
    const folder = node.children[name];
    const folderEl = document.createElement("div");
    folderEl.className = "tree-folder";

    const header = document.createElement("div");
    header.className = "tree-folder-header";
    header.style.paddingLeft = `${depth * 16 + 8}px`;

    const fileCount = countFilesInNode(folder);

    header.innerHTML = `
      <span class="tree-toggle">▶</span>
      <span class="tree-folder-icon">📁</span>
      <label class="tree-folder-label">
        <input type="checkbox" class="folder-checkbox" data-folder="${escapeHtml(folder.name)}" checked>
        <span class="tree-folder-name">${escapeHtml(name)}</span>
      </label>
      <span class="tree-folder-count">(${fileCount} 个文件)</span>
    `;

    folderEl.appendChild(header);

    const childrenContainer = document.createElement("div");
    childrenContainer.className = "tree-folder-children collapsed";
    folderEl.appendChild(childrenContainer);

    // 标记是否已渲染过子节点
    let childrenRendered = false;

    // 折叠/展开（懒加载）
    const toggle = header.querySelector(".tree-toggle");
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      folder.collapsed = !folder.collapsed;
      childrenContainer.classList.toggle("collapsed", folder.collapsed);
      toggle.textContent = folder.collapsed ? "▶" : "▼";

      // 首次展开时渲染子节点
      if (!folder.collapsed && !childrenRendered) {
        childrenRendered = true;
        renderTreeNode(folder, childrenContainer, depth + 1);
        // 同步数据模型中的勾选状态到新渲染的子节点
        syncCheckedState(folder, childrenContainer);
      }
    });

    // 文件夹勾选 - 更新数据模型
    const folderCb = header.querySelector(".folder-checkbox");
    folderCb.addEventListener("change", () => {
      const checked = folderCb.checked;
      setNodeChecked(folder, checked);
      // 联动已渲染的子节点
      childrenContainer.querySelectorAll(".file-checkbox").forEach(cb => {
        cb.checked = checked;
      });
      childrenContainer.querySelectorAll(".folder-checkbox").forEach(cb => {
        cb.checked = checked;
        cb.indeterminate = false;
      });
      updateSelectedCount();
    });

    container.appendChild(folderEl);
  }

  // 渲染文件
  for (const file of node.files) {
    const item = document.createElement("label");
    item.className = "tree-file";
    item.style.paddingLeft = `${depth * 16 + 24}px`;

    const sizeStr = file.fileSize ? formatFileSize(file.fileSize) : "";
    const ext = getFileExtension(file.title);

    item.innerHTML = `
      <input type="checkbox" class="file-checkbox" data-index="${file.index}" checked>
      <span class="tree-file-ext">${ext || "📄"}</span>
      <span class="tree-file-name" title="${escapeHtml(file.path || file.title)}">${escapeHtml(file.title)}</span>
      ${sizeStr ? `<span class="tree-file-size">${sizeStr}</span>` : ""}
    `;

    item.querySelector(".file-checkbox").addEventListener("change", (e) => {
      file.checked = e.target.checked;
      updateSelectedCount();
    });

    container.appendChild(item);
  }
}

/**
 * 同步数据模型中的勾选状态到已渲染的DOM
 */
function syncCheckedState(node, container) {
  // 同步文件夹
  const folderEls = container.querySelectorAll(":scope > .tree-folder");
  folderEls.forEach((folderEl, i) => {
    const folderName = Object.keys(node.children)[i];
    if (folderName) {
      const childNode = node.children[folderName];
      const cb = folderEl.querySelector(":scope > .tree-folder-header .folder-checkbox");
      if (cb) cb.checked = childNode.checked;
      // 递归同步子容器
      const childContainer = folderEl.querySelector(":scope > .tree-folder-children");
      if (childContainer && childContainer.children.length > 0) {
        syncCheckedState(childNode, childContainer);
      }
    }
  });
  // 同步文件
  const fileEls = container.querySelectorAll(":scope > .tree-file");
  fileEls.forEach((fileEl, i) => {
    if (node.files[i]) {
      const cb = fileEl.querySelector(".file-checkbox");
      if (cb) cb.checked = node.files[i].checked;
    }
  });
}

/**
 * 递归设置节点的勾选状态（数据模型层面）
 */
function setNodeChecked(node, checked) {
  node.checked = checked;
  // 递归设置子文件夹
  for (const child of Object.values(node.children)) {
    setNodeChecked(child, checked);
  }
  // 设置文件
  for (const file of node.files) {
    file.checked = checked;
  }
}

/**
 * 从数据模型中收集所有已选文件
 */
function collectCheckedFiles(node) {
  const files = [];
  // 递归子文件夹
  for (const child of Object.values(node.children)) {
    files.push(...collectCheckedFiles(child));
  }
  // 收集已勾选的文件
  for (const file of node.files) {
    if (file.checked) {
      files.push(scannedFiles[file.index]);
    }
  }
  return files;
}

/**
 * 统计节点下文件数
 */
function countFilesInNode(node) {
  let count = node.files.length;
  for (const child of Object.values(node.children)) {
    count += countFilesInNode(child);
  }
  return count;
}

/**
 * 更新父文件夹勾选状态
 */
function updateParentFolderState(element) {
  const folderEl = element.closest(".tree-folder");
  if (!folderEl) return;

  const parentFolder = folderEl.parentElement?.closest(".tree-folder");
  if (!parentFolder) {
    // 顶层，更新全选
    const allChecked = document.querySelectorAll(".file-checkbox:not(:checked)").length === 0;
    document.getElementById("select-all-checkbox").checked = allChecked;
    return;
  }

  const parentCb = parentFolder.querySelector(":scope > .tree-folder-header .folder-checkbox");
  if (!parentCb) return;

  const allChildren = parentFolder.querySelectorAll(".file-checkbox, .folder-checkbox");
  const checkedChildren = parentFolder.querySelectorAll(".file-checkbox:checked, .folder-checkbox:checked");
  parentCb.checked = allChildren.length === checkedChildren.length;
  parentCb.indeterminate = checkedChildren.length > 0 && checkedChildren.length < allChildren.length;

  updateParentFolderState(parentFolder);
}

/**
 * 全部折叠/展开
 */
let allCollapsed = false;
function toggleCollapseAll() {
  allCollapsed = !allCollapsed;
  const btn = document.getElementById("collapse-all-btn");
  btn.textContent = allCollapsed ? "全部展开" : "全部折叠";

  document.querySelectorAll(".tree-folder-children").forEach(el => {
    el.classList.toggle("collapsed", allCollapsed);
  });
  document.querySelectorAll(".tree-toggle").forEach(el => {
    el.textContent = allCollapsed ? "▶" : "▼";
  });
}

/**
 * 显示文件列表（树形目录）
 */
function displayFileList(files) {
  const section = document.getElementById("file-list-section");
  const list = document.getElementById("file-list");
  list.innerHTML = "";

  if (files.length === 0) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");

  // 构建树
  const tree = buildFileTree(files);
  fileTreeData = tree; // 保存树数据模型

  // 渲染
  renderTreeNode(tree, list, 0);

  // 全选/取消全选
  document.getElementById("select-all-checkbox").checked = true;
  document.getElementById("select-all-checkbox").addEventListener("change", (e) => {
    const checked = e.target.checked;
    // 更新数据模型
    if (fileTreeData) {
      setNodeChecked(fileTreeData, checked);
    }
    // 更新已渲染的DOM
    list.querySelectorAll(".file-checkbox, .folder-checkbox").forEach(cb => {
      cb.checked = checked;
      cb.indeterminate = false;
    });
    updateSelectedCount();
  });
}

/**
 * 更新已选文件数量
 */
function updateSelectedCount() {
  let count = 0;
  if (fileTreeData) {
    count = collectCheckedFiles(fileTreeData).length;
  } else {
    count = document.querySelectorAll(".file-checkbox:checked").length;
  }
  document.getElementById("selected-files").textContent = count;
  document.getElementById("download-btn").disabled = count === 0;
}

/**
 * 获取已选文件
 */
function getSelectedFiles() {
  if (fileTreeData) {
    return collectCheckedFiles(fileTreeData);
  }
  const checkboxes = document.querySelectorAll(".file-checkbox:checked");
  return Array.from(checkboxes).map(cb => scannedFiles[parseInt(cb.dataset.index)]);
}

/**
 * 格式化文件大小
 */
function formatFileSize(size) {
  const bytes = parseInt(size);
  if (isNaN(bytes) || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

/**
 * 获取文件扩展名
 */
function getFileExtension(filename) {
  if (!filename) return "";
  const idx = filename.lastIndexOf(".");
  return idx > -1 ? filename.substring(idx + 1).toUpperCase() : "";
}

/**
 * 暂停/恢复下载
 */
async function togglePauseDownload() {
  const pauseBtn = document.getElementById("pause-btn");
  const isPaused = pauseBtn.textContent === "继续";

  if (isPaused) {
    // 恢复下载
    await chrome.runtime.sendMessage({ type: "RESUME_DOWNLOAD" });
    pauseBtn.textContent = "暂停";
    log("▶ 恢复下载", "info");
  } else {
    // 暂停下载
    await chrome.runtime.sendMessage({ type: "PAUSE_DOWNLOAD" });
    pauseBtn.textContent = "继续";
    log("⏸ 暂停下载", "info");
  }
}

/**
 * 取消下载
 */
async function cancelDownload() {
  if (!confirm("确定要取消下载吗？")) return;

  await chrome.runtime.sendMessage({ type: "CANCEL_DOWNLOAD" });
  
  const pauseBtn = document.getElementById("pause-btn");
  pauseBtn.textContent = "暂停";
  
  const downloadBtn = document.getElementById("download-btn");
  downloadBtn.disabled = false;
  downloadBtn.innerHTML = "开始下载";
  
  log("⏹ 已取消下载", "warn");
  showNotification("下载已取消", "info");
}

/**
 * 开始下载
 */
async function startDownload() {
  const selectedFiles = getSelectedFiles();
  if (selectedFiles.length === 0) return;

  const btn = document.getElementById("download-btn");
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner"></span> 下载中...';

  // 重置暂停按钮
  const pauseBtn = document.getElementById("pause-btn");
  pauseBtn.textContent = "暂停";

  const progressDiv = document.getElementById("download-progress");
  progressDiv.classList.remove("hidden");
  document.getElementById("total-count").textContent = selectedFiles.length;

  // 若已选择保存文件夹（File System Access），文件直接写入所选文件夹；否则回退到 Chrome 下载目录
  const customPath = document.getElementById("save-path-input").value.trim();
  // 去掉可能的 📁 前缀
  const cleanPath = customPath.replace(/^📁\s*/, "").trim();
  const outputDir = cleanPath || `IMA_${selectedKb.name}_${new Date().toISOString().slice(0, 10)}`;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "BATCH_DOWNLOAD",
      accountInfo: accountInfo,
      files: selectedFiles,
      outputDir: outputDir,
      concurrency: 3
    });

    if (!response.success) {
      throw new Error(response.error);
    }

    const results = response.data;
    const successCount = results.filter((r) => r.success).length;
    const failedCount = results.filter((r) => !r.success).length;

    log(`✓ 下载完成: 成功 ${successCount}, 失败 ${failedCount}`, successCount > 0 ? "success" : "warn");

    if (failedCount > 0) {
      const failedFiles = results.filter((r) => !r.success);
      failedFiles.forEach((f) => {
        log(`✗ 失败: ${f.file.title} - ${f.error}`, "error");
      });
      showNotification(`下载完成，${failedCount} 个文件失败`, "error");
    } else {
      showNotification(`✓ 成功下载 ${successCount} 个文件`, "success");
    }
  } catch (error) {
    log(`✗ 下载失败: ${error.message}`, "error");
    showNotification("下载失败，请重试", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

/**
 * 更新下载进度
 */
function updateDownloadProgress(data) {
  const { completed, failed, total, currentFile, error } = data;

  document.getElementById("downloaded-count").textContent = completed;
  document.getElementById("failed-count").textContent = failed;
  document.getElementById("current-file").textContent = currentFile || "";

  // 更新进度条
  const progress = ((completed + failed) / total) * 100;
  const progressFill = document.querySelector("#download-progress .progress-fill");
  progressFill.style.width = `${progress}%`;

  if (error) {
    log(`下载失败: ${currentFile} - ${error}`, "error");
  }
}

/**
 * 日志输出
 */
function log(message, level = "info") {
  const logContent = document.getElementById("log-content");
  const entry = document.createElement("div");
  entry.className = `log-entry ${level}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logContent.appendChild(entry);
  logContent.scrollTop = logContent.scrollHeight;
}

/**
 * HTML 转义
 */
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * 格式化时间
 */
function formatTime(timestamp) {
  if (!timestamp || timestamp === "0") return "未知";

  const date = new Date(timestamp * 1000);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`;

  return date.toLocaleDateString("zh-CN");
}

/**
 * 显示通知
 */
function showNotification(message, type = "info") {
  const notification = document.createElement("div");
  notification.className = `notification ${type}`;
  notification.textContent = message;
  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.animation = "slideInRight 0.3s ease-out reverse";
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}
