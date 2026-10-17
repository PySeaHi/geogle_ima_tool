// ============ Offscreen Document：负责文件的实际下载/写入 ============
// service worker 无法使用 FileSystemDirectoryHandle 方法、URL.createObjectURL、FileReader（非 window 上下文），
// 故在此 offscreen 文档（窗口上下文）中完成「写入所选文件夹」或「blob URL 下载」。

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("ima_tool_fs", 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("kv"); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getSaveDirHandle() {
  try {
    const db = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readonly");
      const get = tx.objectStore("kv").get("saveDirHandle");
      get.onsuccess = () => resolve(get.result || null);
      get.onerror = () => reject(get.error);
    });
  } catch (e) {
    return null;
  }
}

async function urlToBlob(url) {
  const resp = await fetch(url, { credentials: "omit" });
  if (!resp.ok) throw new Error(`抓取下载内容失败 HTTP ${resp.status}`);
  return await resp.blob();
}

async function writeBlobToHandle(relativePath, blob) {
  const handle = await getSaveDirHandle();
  if (!handle) throw new Error("未找到已授权的保存目录，请重新在弹窗中选择保存位置");

  const parts = String(relativePath).split("/").filter(Boolean);
  if (parts.length === 0) throw new Error("空路径");

  let dir = handle;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create: true });
  }
  const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();

  return relativePath;
}

function waitForDownloadCompletion(downloadId) {
  return new Promise((resolve, reject) => {
    const listener = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state && delta.state.current === "complete") {
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      } else if (delta.state && delta.state.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(listener);
        reject(new Error(`下载中断: ${(delta.error && delta.error.current) || "未知错误"}`));
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "OFFSCREEN_DOWNLOAD_FILE") return;

  (async () => {
    try {
      const sourceUrl = message.url;
      const relativePath = message.relativePath;
      const fallbackFilename = message.fallbackFilename;

      // 1. 先把内容抓成 Blob（http/https 或 data: 均支持）
      const blob = await urlToBlob(sourceUrl);

      // 2. 优先写入用户选择的文件夹（目录结构 = 知识库层级）
      const handle = await getSaveDirHandle();
      let permission = "denied";
      if (handle && handle.queryPermission) {
        try {
          permission = await handle.queryPermission({ mode: "readwrite" });
        } catch (e) {
          permission = "denied";
        }
      }

      if (handle && permission === "granted") {
        const relPath = await writeBlobToHandle(relativePath, blob);
        sendResponse({ success: true, path: relPath, viaFilesystem: true });
        return;
      }

      // 3. 回退：用 blob URL 下载，避免服务器 Content-Disposition 改写文件名
      const objectUrl = URL.createObjectURL(blob);
      const downloadId = await new Promise((resolve, reject) => {
        chrome.downloads.download(
          { url: objectUrl, filename: fallbackFilename, saveAs: false },
          (id) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(id);
            }
          }
        );
      });
      await waitForDownloadCompletion(downloadId);
      URL.revokeObjectURL(objectUrl);

      sendResponse({ success: true, path: fallbackFilename, viaFilesystem: false });
    } catch (e) {
      console.error("[Offscreen] 下载/写入失败:", e);
      sendResponse({ success: false, error: e.message, viaFilesystem: false });
    }
  })();

  // 异步响应
  return true;
});