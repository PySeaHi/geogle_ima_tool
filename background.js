// ============ IMA 下载工具 - Background Service Worker ============

const IMA_BASE = "https://ima.qq.com/cgi-bin";
const IMA_SECURE_URL = "https://ima.qq.com/cgi-bin/s/file_manager/get_media";

// 下载控制状态
let downloadState = {
  isPaused: false,
  isCancelled: false
};

// 当前进行中的下载 ID 集合（用于暂停/恢复/取消真实下载）
let activeDownloadIds = new Set();

// ============ 下载记录持久化（任务级断点续传） ============

/**
 * 下载记录存储 key（按知识库隔离）
 */
function downloadRecordsKey(knowledgeBaseId) {
  return `download_records_${knowledgeBaseId}`;
}

/**
 * 读取某知识库的下载记录（mediaId -> { status, ... }）
 */
async function loadDownloadRecords(knowledgeBaseId) {
  const key = downloadRecordsKey(knowledgeBaseId);
  const got = await chrome.storage.local.get(key);
  return got[key] || {};
}

/**
 * 标记文件下载成功
 */
async function markFileDownloaded(file, result) {
  return enqueueRecordWrite(async () => {
    const key = downloadRecordsKey(file.knowledgeBaseId);
    const records = await loadDownloadRecords(file.knowledgeBaseId);
    records[file.mediaId] = {
      status: "done",
      title: file.title,
      doneAt: Date.now(),
      path: (result && result.path) || ""
    };
    await chrome.storage.local.set({ [key]: records });
  });
}

/**
 * 标记文件下载失败
 */
async function markFileFailed(file, error) {
  return enqueueRecordWrite(async () => {
    const key = downloadRecordsKey(file.knowledgeBaseId);
    const records = await loadDownloadRecords(file.knowledgeBaseId);
    records[file.mediaId] = {
      status: "failed",
      title: file.title,
      failAt: Date.now(),
      error: error || "未知错误"
    };
    await chrome.storage.local.set({ [key]: records });
  });
}

// 记录写入串行化：并发批次的读-改-写会相互覆盖，用队列保证逐条写入
let recordWriteQueue = Promise.resolve();
function enqueueRecordWrite(fn) {
  const next = recordWriteQueue.then(fn, fn);
  recordWriteQueue = next.catch(() => {});
  return next;
}

// RSA 公钥（用于加密 AES 密钥）
const RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx9h6SY1LO88wRVKdOC5U
tjYTXfMpUqCK22FemW9ba4812nVjF4Va+guoHXdBePkhsQmz94PeqqZiSN/YekiV
CU6HbWivdhKcs6LcYMT+sw4cwtMZ1NOJEkY1ujOWFnmNmpK243wwlf+RwE/L+xOJ
8vy/EBuYDv06M+BbccO832bOpWsOFYPPP5KtOmOaqXq6Fgu1vOrXmQIo0q8WmO09
PvjHLwIruqthV2dBcVI1qMEKejM1SKwzCWb78t+fUsr3OjDqApWma3h10hGKcin4
NIGdfITwmiBmS+R1Mr8P/ssNq0ptvr9+VqUvsJD7ASVCPo9EG658fZYGil6oH5JN
OQIDAQAB
-----END PUBLIC KEY-----`;

// ============ 加密工具函数 ============

/**
 * 将 Uint8Array 转换为 Base64 字符串
 */
function uint8ArrayToBase64(uint8Array) {
  let str = "";
  for (let i = 0; i < uint8Array.length; i += 32768) {
    str += String.fromCharCode(...uint8Array.subarray(i, i + 32768));
  }
  return btoa(str);
}

/**
 * 将 Base64 字符串转换为 Uint8Array
 */
function base64ToUint8Array(base64) {
  const binary = atob(base64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 解析 RSA 公钥
 */
function parsePublicKey() {
  const pem = RSA_PUBLIC_KEY.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
  return base64ToUint8Array(pem);
}

/**
 * 导入 RSA 公钥
 */
async function importPublicKey() {
  const keyData = parsePublicKey();
  return await crypto.subtle.importKey(
    "spki",
    keyData,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );
}

/**
 * 加密请求体（AES + RSA）
 */
async function encryptRequestBody(data) {
  // 1. 生成 AES 密钥
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 128 },
    true,
    ["encrypt", "decrypt"]
  );

  // 2. 导出 AES 密钥
  const aesKeyRaw = await crypto.subtle.exportKey("raw", aesKey);

  // 3. 生成随机 IV
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // 4. 使用 AES-GCM 加密数据
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv, tagLength: 128 },
    aesKey,
    new TextEncoder().encode(JSON.stringify(data))
  );

  // 5. 组合 IV 和加密数据
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  // 6. 使用 RSA 加密 AES 密钥
  const rsaKey = await importPublicKey();
  const encryptedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    rsaKey,
    aesKeyRaw
  );

  return {
    aesKey: aesKey,
    body: uint8ArrayToBase64(combined),
    encryptedKey: uint8ArrayToBase64(new Uint8Array(encryptedKey))
  };
}

/**
 * 解密响应体
 */
async function decryptResponseBody(responseBase64, aesKey) {
  const data = base64ToUint8Array(responseBase64);
  
  if (data.length <= 28) {
    throw new Error("IMA 安全响应格式异常");
  }

  // 提取 IV 和加密数据
  const iv = data.subarray(0, 12);
  const encrypted = data.subarray(12);

  // 使用 AES-GCM 解密
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv, tagLength: 128 },
    aesKey,
    encrypted
  );

  return new TextDecoder().decode(decrypted);
}

// ============ 工具函数 ============

/**
 * 计算 bkn (CSRF token)
 */
function getBkn(token) {
  let t = 5381;
  for (let n = 0; n < token.length; n++) {
    t += (t << 5) + token.charCodeAt(n);
  }
  return (t & 2147483647).toString();
}

/**
 * 构造 IMA API 请求头
 */
function prepareHeaders(accountInfo, webVersion = "999.999.999") {
  const guidPart = accountInfo.guid.split("-")[1] || "";
  const token = accountInfo.token || "";

  const cookie = [
    `IMA-GUID=${guidPart}`,
    `IMA-REFRESH-TOKEN=${accountInfo.refreshToken}`,
    `IMA-TOKEN=${token}`,
    `IMA-UID=${accountInfo.uid}`,
    "UID-TYPE=2",
    "TOKEN-TYPE=14",
    "PLATFORM=H5",
    "CLIENT-TYPE=256020",
    `WEB-VERSION=${webVersion}`
  ].join("; ");

  return {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "from_browser_ima": "1",
    "x-ima-bkn": getBkn(token),
    "x-ima-cookie": cookie,
    "extension_version": webVersion
  };
}

/**
 * 验证并修复 Chrome downloads API 可用的文件名
 * Chrome 对 filename 参数有严格要求
 */
function validateDownloadPath(path) {
  if (!path || typeof path !== "string") return "unnamed";
  
  // 移除开头的 / 或 \（必须是相对路径）
  let clean = path.replace(/^[/\\]+/, "");
  
  // 移除 .. 段（防止路径遍历）
  clean = clean.split("/").filter(seg => seg !== ".." && seg !== ".").join("/");
  
  // 移除连续斜杠
  clean = clean.replace(/\/+/g, "/");
  
  // 移除尾部斜杠
  clean = clean.replace(/\/+$/, "");
  
  // 检查是否为空
  if (!clean) return "unnamed";
  
  // 检查总长度（Chrome 限制约 1024 字符）
  if (clean.length > 900) {
    // 截断最后一段（文件名）
    const lastSlash = clean.lastIndexOf("/");
    if (lastSlash > 0) {
      const dir = clean.slice(0, lastSlash);
      const file = clean.slice(lastSlash + 1);
      const maxFileLen = 900 - dir.length - 1;
      clean = dir + "/" + file.slice(0, Math.max(50, maxFileLen));
    } else {
      clean = clean.slice(0, 900);
    }
  }
  
  return clean;
}

/**
 * 分离文件名的基础部分和扩展名
 */
function splitBaseExt(name) {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) {
    return { base: name, ext: "" };
  }
  return { base: name.slice(0, dotIndex), ext: name.slice(dotIndex) };
}

/**
 * 限制文件名长度（保留扩展名）
 */
function truncateFileName(name, maxLength = 200) {
  if (name.length <= maxLength) return name;
  const { base, ext } = splitBaseExt(name);
  if (!ext) return name.slice(0, maxLength);
  const newBaseLen = maxLength - ext.length;
  if (newBaseLen <= 0) return name.slice(0, maxLength);
  return `${base.slice(0, newBaseLen)}${ext}`;
}

/**
 * 清理文件名（移除非法字符）- 完全复现 ima_download_tool 的逻辑
 */
function sanitizeFileName(name) {
  if (!name || typeof name !== "string") return "unnamed";

  // 1. 移除零宽字符和控制字符
  let clean = name
    .replace(/[\u200B\u200C\u200D\uFEFF\u2060\u180E]/g, "")
    .replace(/[\u2000-\u200F\u2028-\u202F\u205F-\u206F]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");

  // 2. 替换 Windows/Chrome 非法字符（使用特殊 Unicode 字符替代）
  clean = clean
    .replace(/:+/g, "ː")           // 冒号 → 修饰符号冒号
    .replace(/\?+/g, "_")          // 问号 → 下划线
    .replace(/\*+/g, "_")          // 星号 → 下划线
    .replace(/<+/g, "◄")           // 小于号 → 左三角
    .replace(/>+/g, "▶")           // 大于号 → 右三角
    .replace(/"+/g, "'")           // 双引号 → 单引号
    .replace(/\|+/g, "¦")          // 竖线 → 断竖线
    .replace(/[/\\]+/g, "_")       // 斜杠 → 下划线
    .replace(/#+/g, "♯")           // 井号 → 音乐升号
    .replace(/\s+/g, " ")          // 多个空白 → 单空格
    .replace(/^[\s.]+/, "")        // 移除开头空白和点
    .replace(/[\s.]+$/, "")        // 移除结尾空白和点
    .trim();

  // 3. 字符白名单过滤：只保留安全字符
  //    ASCII可打印(32-126)、CJK统一汉字(19968-40959)、
  //    CJK符号标点(12288-12351)、全角ASCII(65280-65519)、
  //    特殊替换字符(ː◄▶¦♯)
  const safeChars = "ː◄▶¦♯";
  clean = clean.split("").filter(ch => {
    const code = ch.charCodeAt(0);
    return (code >= 32 && code <= 126) ||    // ASCII 可打印
           (code >= 19968 && code <= 40959) || // CJK 汉字
           (code >= 12288 && code <= 12351) || // CJK 符号标点
           (code >= 65280 && code <= 65519) || // 全角 ASCII
           safeChars.includes(ch);             // 特殊替换字符
  }).join("");

  // 4. 处理 Windows 保留名
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..+)?$/i;
  if (reserved.test(clean)) {
    clean = `_${clean}_`;
  }

  // 5. 限制长度
  if (clean.length > 200) {
    clean = clean.slice(0, 200).trim();
  }

  return clean || "unnamed";
}

/**
 * 异步清理文件名（用于需要平台检测的场景）
 */
async function sanitizeFileNameAsync(name, maxLength = 200) {
  if (!name || typeof name !== "string") return "unnamed";
  
  const { base, ext } = splitBaseExt(name);
  const cleanBase = sanitizeFileName(base).slice(0, Math.max(1, maxLength - (ext ? ext.length : 0))) || "unnamed";
  const cleanExt = ext ? `.${sanitizeFileName(ext.slice(1)).replace(/\./g, "")}` : "";
  const result = truncateFileName(`${cleanBase}${cleanExt}`, maxLength);
  
  return result;
}

/**
 * 根据 source_path 补全/校正文件名扩展名（复现 ima_download_tool 的 xt 逻辑）
 * IMA 的 title 可能不含扩展名，需从 source_path 提取并补齐，否则会被服务器 Content-Disposition 覆盖成"下载.pdf"
 */
function ensureExtension(name, sourcePath) {
  // 只从 source_path 提取扩展名；绝不把 source_path 的基名（media_id）当作最终文件名
  const srcBase = String(sourcePath || "").split(/[\\/]/).pop() || "";
  const m = srcBase.match(/(\.[A-Za-z0-9]{1,10})$/);
  const base = String(name || "").trim() || "未命名文件";
  if (!m) return base;
  return base.toLowerCase().endsWith(m[1].toLowerCase()) ? base : `${base}${m[1]}`;
}

/**
 * 安全路径处理 - 完全复现 ima_download_tool 的逻辑
 */
async function safePath(path) {
  if (!path || !path.trim()) return "";

  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return "";

  const processed = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    // 最后一段使用异步清理（保留扩展名），其他段使用同步清理
    processed.push(isLast ? await sanitizeFileNameAsync(part) : sanitizeFileName(part));
  }

  return processed.filter(Boolean).join("/");
}

// ============ 知识库扫描 ============

/**
 * 获取知识库列表
 */
async function getKnowledgeBaseList(headers) {
  const response = await fetch(`${IMA_BASE}/knowledge_tab_reader/get_home_page_data`, {
    method: "POST",
    headers: headers,
    body: JSON.stringify({
      need_folder_number: true,
      knowledge_list_req: {
        knowledge_base_id: "",
        need_default_cover: false,
        sort_type: 0,
        limit: 50,
        cursor: ""
      }
    })
  });

  const data = await response.json();
  // console.log(`[API] get_home_page_data 响应:`, JSON.stringify(data, null, 2).substring(0, 3000));

  if (data.code !== undefined && data.code !== 0) {
    throw new Error(`获取知识库列表失败: ${data.msg || data.message || `code ${data.code}`}`);
  }

  const kbList = (data.results || []).map(result => {
    // console.log(`[API] result.type=${result.type}, knowledge_base_list:`, JSON.stringify(result.knowledge_base_list, null, 2).substring(0, 2000));
    return (result.knowledge_base_list || []).map(kb => {
      // console.log(`[API] kb 原始数据:`, JSON.stringify(kb, null, 2).substring(0, 1000));
      const id = kb.basic_info?.knowledge_base_id || kb.knowledge_base_id || kb.id;
      // console.log(`[API] 解析出的 id: ${id}`);
      return {
        id: id,
        name: kb.basic_info?.name || kb.name || "",
        type: result.type,
        memberCount: kb.member_info?.member_count || 0,
        coverUrl: kb.basic_info?.cover_url || "",
        size: kb.basic_info?.size || "0",
        description: kb.basic_info?.description || "",
        updateTime: kb.basic_info?.update_timestamp_sec || "0",
        creatorName: kb.basic_info?.creator?.nickname || "",
        fileCount: 0
      };
    });
  }).flat();

  console.log(`[API] 解析到 ${kbList.length} 个知识库, ids: ${kbList.map(k => k.id).join(', ')}`);
  return kbList;
}

/**
 * 获取文件夹内容
 */
async function getFolderContents(headers, knowledgeBaseId, folderId, cursor = "") {
  const requestBody = {
    sort_type: 9,
    need_default_cover: true,
    knowledge_base_id: knowledgeBaseId,
    folder_id: folderId,
    cursor: cursor,
    limit: 50,
    version: "",
    ext_info: {}
  };

  // console.log(`[API] get_knowledge_list 请求: folderId=${folderId}, cursor=${cursor}`);

  const response = await fetch(`${IMA_BASE}/knowledge_tab_reader/get_knowledge_list`, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(requestBody)
  });

  const data = await response.json();
  // console.log(`[API] get_knowledge_list 响应:`, JSON.stringify(data, null, 2).substring(0, 2000));

  if (data.code !== undefined && data.code !== 0) {
    throw new Error(`获取文件夹失败: ${data.msg || data.message || `code ${data.code}`}`);
  }

  // 复现 ima_download_tool 的解析逻辑：真实字段在 data.data 下
  const a = data.data ?? data;
  const items = Array.isArray(a.knowledge_list) ? a.knowledge_list : (a.list || a.items || []);
  const isEnd = a.is_end !== false;
  const nextCursor = a.next_cursor || data.next_cursor || data.nextCursor || data.cursor || "";

  // console.log(`[API] 解析结果: items=${items.length}, isEnd=${isEnd}, nextCursor=${nextCursor}`);

  return { items, isEnd, nextCursor };
}

/**
 * BFS 遍历知识库所有文件
 */
async function collectAllFiles(headers, knowledgeBaseId, onProgress, useCache = true) {
  // 检查缓存
  if (useCache) {
    const cacheKey = `scan_cache_${knowledgeBaseId}`;
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey]) {
      const cache = cached[cacheKey];
      console.log(`[缓存] 使用缓存数据: ${cache.files.length} 个文件, ${cache.folders.length} 个文件夹`);
      if (onProgress) {
        onProgress(cache.files.length, cache.folders.length);
      }
      return { files: cache.files, folders: cache.folders, fromCache: true };
    }
  }

  const allFiles = [];
  const allFolders = [];
  const queue = [{ folderId: knowledgeBaseId, pathSegments: [] }];
  let processedCount = 0;

  console.log(`[收集] 开始扫描知识库 ${knowledgeBaseId}`);

  while (queue.length > 0) {
    // 每批处理 5 个文件夹
    const batch = queue.splice(0, 5);

    const results = await Promise.all(
      batch.map(async ({ folderId, pathSegments }) => {
        const items = [];
        let cursor = "";
        let isEnd = false;

        // 分页获取文件夹内容
        while (!isEnd) {
          const result = await getFolderContents(headers, knowledgeBaseId, folderId, cursor);
          items.push(...result.items);
          cursor = result.nextCursor;
          isEnd = result.isEnd;
        }

        return { items, pathSegments };
      })
    );

    // 处理结果
    for (const { items, pathSegments } of results) {
      for (const item of items) {
        // 调试：打印第一个文件的完整数据结构
        if (allFiles.length === 0 && allFolders.length === 0) {
          console.log(`[调试] API 响应数据结构:`, JSON.stringify(item, null, 2).substring(0, 2000));
        }
        
        const isFolder = !!item.folder_info;
        // 尝试多个可能的文件名字段，优先使用 title（通常是中文名称）
        // 避免使用 media_id 作为文件名（那是随机字符串）
        const fileName = item.title || (item.folder_info && item.folder_info.name) || item.name || item.display_name || item.file_name || "unnamed";
        // 用数组存储目录层级，避免标题中的 / 字符导致路径解析错误
        const currentSegments = [...pathSegments, fileName];

        if (isFolder) {
          allFolders.push({
            title: fileName,
            mediaId: item.media_id,
            path: currentSegments.join("/"),
            folderSegments: currentSegments,
            folderInfo: item.folder_info
          });
          // 加入队列继续遍历，传递数组而非字符串
          queue.push({
            folderId: item.folder_info.folder_id || item.media_id,
            pathSegments: currentSegments
          });
        } else {
          allFiles.push({
            title: fileName,
            mediaId: item.media_id,
            mediaType: item.media_type,
            fileSize: item.file_size,
            path: currentSegments.join("/"),
            folderSegments: pathSegments, // 只存目录部分，不包含文件名
            updateTime: item.update_time,
            knowledgeBaseId: knowledgeBaseId
          });
        }
      }
    }

    processedCount = allFiles.length;
    if (onProgress) {
      onProgress(processedCount, allFolders.length);
    }

    // console.log(`[收集] 已扫描 ${allFiles.length} 个文件, ${allFolders.length} 个文件夹, 队列剩余 ${queue.length}`);
  }

  console.log(`[收集] 扫描完成: ${allFiles.length} 个文件, ${allFolders.length} 个文件夹`);
  
  // 保存到缓存 - 只保留下载必需的最小字段集，避免超出 chrome.storage.local 配额
  const cacheKey = `scan_cache_${knowledgeBaseId}`;
  const leanFiles = allFiles.map(f => ({
    title: f.title,
    mediaId: f.mediaId,
    mediaType: f.mediaType,
    fileSize: f.fileSize,
    path: f.path,
    folderSegments: f.folderSegments,
    knowledgeBaseId: f.knowledgeBaseId
  }));
  const leanFolders = allFolders.map(f => ({
    title: f.title,
    mediaId: f.mediaId,
    path: f.path,
    folderSegments: f.folderSegments
  }));
  const cacheData = {
    files: leanFiles,
    folders: leanFolders,
    timestamp: Date.now()
  };
  
  try {
    await chrome.storage.local.set({ [cacheKey]: cacheData });
    console.log(`[缓存] 已保存扫描结果到缓存（精简模式）`);
  } catch (e) {
    console.warn(`[缓存] 保存缓存失败（配额不足）: ${e.message}，后续将不使用缓存`);
    // 如果保存失败，尝试清理旧缓存
    try {
      await chrome.storage.local.remove(cacheKey);
    } catch (_) {}
  }
  
  return { files: allFiles, folders: allFolders, fromCache: false };
}

// ============ 文件下载 ============

/**
 * 深度搜索下载链接（复现 ima_download_tool 的 v() 逻辑）
 * BFS 遍历响应对象，寻找 jump_url / download_url 等字段，兼容对象形式 {url}
 */
function findJumpUrl(data) {
  const queue = [data];
  const visited = new Set();
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || visited.has(node)) continue;
    visited.add(node);

    // jump_url_info.url 优先
    if (node.jump_url_info && typeof node.jump_url_info.url === "string" && node.jump_url_info.url) {
      return node.jump_url_info.url;
    }
    // 直接字段（字符串或 {url} 对象）
    const direct = node.jump_url || node.jumpUrl || node.download_url || node.downloadUrl || node.file_url || node.fileUrl;
    if (typeof direct === "string" && direct) return direct;
    if (direct && typeof direct === "object" && typeof direct.url === "string" && direct.url) return direct.url;

    // 递归子对象
    if (node.data && typeof node.data === "object") queue.push(node.data);
    if (node.knowledge && typeof node.knowledge === "object") queue.push(node.knowledge);
    if (node.result && typeof node.result === "object") queue.push(node.result);
  }
  return "";
}

/**
 * 获取文件下载链接（使用加密接口）
 */
async function getMediaDownloadUrl(headers, mediaId, knowledgeBaseId) {
  const body = {
    media_id: mediaId,
    ...(knowledgeBaseId ? { knowledge_base_id: knowledgeBaseId } : {})
  };

  // 加密请求体
  const encrypted = await encryptRequestBody(body);

  // 构造加密请求头
  const secureHeaders = new Headers(headers);
  secureHeaders.set("x-ima-cm", "1");
  secureHeaders.set("x-ima-ckey", encrypted.encryptedKey);
  secureHeaders.delete("x-ima-ctk");

  const response = await fetch(IMA_SECURE_URL, {
    method: "POST",
    headers: secureHeaders,
    credentials: "include",
    body: encrypted.body
  });

  if (!response.ok) {
    throw new Error(`IMA 安全下载接口 HTTP ${response.status}`);
  }

  const responseText = await response.text();
  if (!responseText) {
    throw new Error("IMA 安全下载接口返回空响应");
  }

  // 解密响应
  const decryptedText = await decryptResponseBody(responseText, encrypted.aesKey);
  const data = JSON.parse(decryptedText);

  console.log(`[API] get_media 响应:`, JSON.stringify(data, null, 2).substring(0, 1000));

  // 检查登录过期
  if (data.code === 600001) {
    throw new Error("IMA 登录已过期，请重新登录");
  }

  // 从响应中提取下载链接（深度搜索，兼容嵌套与对象形式）
  const jumpUrl = findJumpUrl(data);

  if (!jumpUrl) {
    console.warn(`[API] 未找到下载链接，完整响应:`, JSON.stringify(data));
  }

  // 判断是否为外部链接（非 IMA 自身文件）
  const isExternalLink = jumpUrl && !jumpUrl.includes("ima.qq.com") && !jumpUrl.includes("cos.") && !jumpUrl.includes("myqcloud");
  const mediaType = data.media_type;
  
  // 提取文件名（get_media 的真实元数据在 data.knowledge 下，复现 ima_download_tool 的 Ot 逻辑）
  const knowledge = data.knowledge || (data.data && data.data.knowledge) || {};
  const title = knowledge.title || data.title || data.data?.title || data.name || data.display_name || data.file_name || "";

  console.log(`[API] jumpUrl=${jumpUrl}, isExternalLink=${isExternalLink}, mediaType=${mediaType}, title=${title}`);

  return {
    success: !!jumpUrl,
    jumpUrl: jumpUrl,
    sourcePath: knowledge.source_path || knowledge.raw_file_url ||
                data.source_path || data.raw_file_url ||
                data.data?.source_path || data.data?.raw_file_url || "",
    fileSize: knowledge.file_size || data.file_size || "0",
    title: title,
    isExternalLink: isExternalLink,
    mediaType: mediaType,
    raw: data
  };
}

/**
 * 抓取外部链接内容（如微信文章）
 * background script 不受 CORS 限制，可以直接 fetch 外部 URL
 */
async function fetchExternalContent(url, title) {
  console.log(`[外部链接] 开始抓取: ${url}`);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://mp.weixin.qq.com/"
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const contentType = response.headers.get("content-type") || "";
    
    // 如果是 HTML 内容，直接返回
    if (contentType.includes("text/html") || contentType.includes("text/plain") || url.includes("mp.weixin.qq.com")) {
      const html = await response.text();
      console.log(`[外部链接] 抓取成功, HTML 长度: ${html.length}`);
      return {
        success: true,
        content: html,
        contentType: "text/html",
        fileName: (title || "article").replace(/[<>:"|?*\/\\]/g, "_").trim() + ".html"
      };
    }
    
    // 如果是二进制内容，返回 base64（分块处理避免栈溢出）
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
    }
    const base64 = btoa(binary);
    const mime = contentType.split(";")[0].trim() || "application/octet-stream";
    const ext = mime.split("/").pop() || "bin";
    
    return {
      success: true,
      content: `data:${mime};base64,${base64}`,
      contentType: mime,
      isDataUrl: true,
      fileName: (title || "file").replace(/[<>:"|?*\/\\]/g, "_").trim() + "." + ext
    };
  } catch (error) {
    console.error(`[外部链接] 抓取失败: ${error.message}`);
    return {
      success: false,
      error: error.message,
      fallbackUrl: url
    };
  }
}

// ============ File System Access 写文件（写入用户选中的任意文件夹） ============

/**
 * 确保 offscreen document 已创建（用于执行 File System Access 写入与 blob 下载）。
 * MV3 service worker 不支持 FileSystemDirectoryHandle（非 window 上下文），
 * 写入必须放到 offscreen document（窗口上下文）执行。
 */
let offscreenReady = false;

async function ensureOffscreenDocument() {
  if (offscreenReady) return;
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    if (contexts && contexts.length > 0) {
      offscreenReady = true;
      return;
    }
  } catch (e) {
    // getContexts 不可用（旧 Chrome）时忽略，走 createDocument
  }
  try {
    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ["BLOBS"],
      justification: "将文件写入用户通过 showDirectoryPicker 选择的文件夹"
    });
  } catch (e) {
    // SW 重启后 offscreen 可能仍存在，忽略“已存在”类错误
  }
  offscreenReady = true;
}

/**
 * 通过 offscreen document 完成文件下载/写入。
 * offscreen 是窗口上下文，拥有 URL.createObjectURL、FileSystemDirectoryHandle 与 chrome.downloads。
 * 优先写入用户选择的文件夹（目录结构 = 知识库层级）；否则用 blob URL 下载以避免服务器改写文件名。
 * @param {string} sourceUrl 内容来源 URL（http/https 或 data:）
 * @param {string} relativePath 相对路径（知识库层级 + 文件名，不含输出目录顶层）
 * @param {string} fallbackFilename 回退下载到浏览器下载目录时的相对路径（含输出目录）
 */
async function downloadViaOffscreen(sourceUrl, relativePath, fallbackFilename) {
  await ensureOffscreenDocument();
  const send = () => new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "OFFSCREEN_DOWNLOAD_FILE", url: sourceUrl, relativePath, fallbackFilename },
      (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message, viaFilesystem: false });
        } else {
          resolve(resp || { success: false, error: "offscreen 无响应", viaFilesystem: false });
        }
      }
    );
  });

  let resp = await send();
  // offscreen 可能被 Chrome 自动回收，连接失败则重建一次再试
  if (!resp.success && /Receiving end does not exist|Could not establish connection/i.test(resp.error || "")) {
    offscreenReady = false;
    await ensureOffscreenDocument();
    resp = await send();
  }
  return resp;
}

/**
 * Blob 转 data URL（service worker 无 FileReader，用 arrayBuffer 手动转）
 */
async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

/**
 * 下载单个文件
 * 优先写入用户通过 showDirectoryPicker 选中的文件夹（目录结构 = 知识库层级）；
 * 未选择文件夹时回退到 Chrome Downloads API（下载到浏览器下载目录）。
 */
async function downloadFile(headers, file, savePath) {
  // 1. 获取下载链接
  const result = await getMediaDownloadUrl(headers, file.mediaId, file.knowledgeBaseId);
  if (!result.success) {
    throw new Error(`获取下载链接失败: ${file.title}`);
  }

  const fileTitle = result.title || file.title;

  // 知识库目录层级（写入所选文件夹时保持与页面一致的结构）
  let folderSegs = [];
  if (file.folderSegments && Array.isArray(file.folderSegments)) {
    folderSegs = file.folderSegments.map(s => sanitizeFileName(s)).filter(Boolean);
  } else if (file.path) {
    const parts = file.path.split("/").filter(Boolean);
    if (parts.length > 1) parts.pop();
    folderSegs = parts.map(s => sanitizeFileName(s)).filter(Boolean);
  }

  // 2. 计算内容来源 sourceUrl 与最终文件名 finalName
  let sourceUrl = result.jumpUrl;
  let finalName;

  if (result.isExternalLink) {
    const extResult = await fetchExternalContent(result.jumpUrl, fileTitle);
    if (extResult.success) {
      if (extResult.isDataUrl) {
        sourceUrl = extResult.content;
        finalName = savePath.replace(/\.[^.]+$/, "") + "." + (extResult.fileName.split(".").pop() || "bin");
      } else {
        sourceUrl = await blobToDataUrl(new Blob([extResult.content], { type: "text/html" }));
        finalName = savePath.replace(/\.[^.]+$/, "") + ".html";
      }
    } else {
      console.warn(`[下载] ${fileTitle} 外部链接抓取失败: ${extResult.error}，降级为链接文件`);
      const urlContent = `链接地址: ${result.jumpUrl}\n标题: ${fileTitle}\n\n请在浏览器中打开上述链接访问内容。`;
      sourceUrl = await blobToDataUrl(new Blob([urlContent], { type: "text/plain" }));
      finalName = savePath + ".txt";
    }
    finalName = finalName.split("/").filter(Boolean).pop() || "未命名文件";
  } else {
    // 3. 正常文件
    const safeTitle = await sanitizeFileNameAsync(fileTitle);
    finalName = ensureExtension(safeTitle, result.sourcePath);
  }

  // 相对路径：写入所选文件夹内部（不含输出目录顶层）
  const relativePath = validateDownloadPath([...folderSegs, finalName].join("/"));

  // 回退路径：浏览器下载目录下（含输出目录顶层）
  const slashIdx = savePath.lastIndexOf("/");
  const dirPart = slashIdx === -1 ? "" : savePath.slice(0, slashIdx);
  const fallbackPath = validateDownloadPath([dirPart, finalName].filter(Boolean).join("/"));

  // 4. 统一交给 offscreen 完成「写所选文件夹 或 blob URL 下载」
  const resp = await downloadViaOffscreen(sourceUrl, relativePath, fallbackPath);
  if (!resp.success) {
    throw new Error(resp.error || "写入/下载失败");
  }

  if (resp.viaFilesystem) {
    console.log(`[下载] ${fileTitle} 已写入所选文件夹: ${relativePath}`);
  } else {
    console.log(`[下载] ${fileTitle} 已保存: ${fallbackPath}`);
  }

  return { success: true, path: resp.path, viaFilesystem: resp.viaFilesystem, isExternalLink: !!result.isExternalLink };
}

// ============ 消息处理 ============

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    try {
      switch (message.type) {
        case "GET_ACCOUNT_INFO": {
          // 从 content script 获取账号信息
          const tab = await getOrCreateImaTab();
          try {
            const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_ACCOUNT_INFO" });
            return response;
          } catch (e) {
            // content script 未注入，使用 scripting API 作为后备方案
            console.log("[Background] content script 未注入，使用 scripting 后备方案");
            const results = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => {
                const data = localStorage.getItem("ima-universal-local-storage-accountInfo");
                if (!data) return { success: false, error: "未找到账号信息，请先登录 IMA" };
                try {
                  const parsed = JSON.parse(data);
                  return {
                    success: true,
                    data: {
                      guid: parsed.guid || "",
                      refreshToken: parsed.refreshToken || "",
                      token: parsed.token || "",
                      uid: parsed.uid || ""
                    }
                  };
                } catch (err) {
                  return { success: false, error: "解析账号信息失败" };
                }
              }
            });
            if (results && results[0] && results[0].result) {
              return results[0].result;
            }
            return { success: false, error: "无法获取账号信息" };
          }
        }

        case "GET_KNOWLEDGE_BASE_LIST": {
          const { accountInfo } = message;
          const headers = prepareHeaders(accountInfo);
          const list = await getKnowledgeBaseList(headers);
          return { success: true, data: list };
        }

        case "COLLECT_FILES": {
          const { accountInfo, knowledgeBaseId, useCache = true } = message;
          const headers = prepareHeaders(accountInfo);
          const result = await collectAllFiles(headers, knowledgeBaseId, (fileCount, folderCount) => {
            // 发送进度更新
            chrome.runtime.sendMessage({
              type: "COLLECT_PROGRESS",
              fileCount,
              folderCount
            }).catch(() => {});
          }, useCache);
          return { success: true, data: result };
        }

        case "CLEAR_SCAN_CACHE": {
          // 清除所有知识库的扫描缓存
          const all = await chrome.storage.local.get(null);
          const keysToRemove = Object.keys(all).filter(k => k.startsWith("scan_cache_"));
          if (keysToRemove.length > 0) {
            await chrome.storage.local.remove(keysToRemove);
            console.log(`[缓存] 已清除 ${keysToRemove.length} 个缓存`);
          }
          return { success: true };
        }

        case "DOWNLOAD_FILE": {
          const { accountInfo, file, savePath } = message;
          const headers = prepareHeaders(accountInfo);
          const safePath = await buildSafePath(savePath);
          const result = await downloadFile(headers, file, safePath);
          return { success: true, data: result };
        }

        case "BATCH_DOWNLOAD": {
          const { accountInfo, files, outputDir, concurrency = 3 } = message;
          const headers = prepareHeaders(accountInfo);
          const results = await batchDownload(headers, files, outputDir, concurrency);
          return { success: true, data: results };
        }

        case "GET_DOWNLOAD_URL": {
          const { accountInfo, file } = message;
          const headers = prepareHeaders(accountInfo);
          const result = await getMediaDownloadUrl(headers, file.mediaId, file.knowledgeBaseId);
          return { success: true, data: result };
        }

        case "FETCH_EXTERNAL_CONTENT": {
          const { url, title } = message;
          const contentResult = await fetchExternalContent(url, title);
          return { success: true, data: contentResult };
        }

        case "PAUSE_DOWNLOAD": {
          downloadState.isPaused = true;
          // 真正暂停正在进行的 Chrome 下载
          const pausedIds = [];
          for (const id of activeDownloadIds) {
            try {
              await chrome.downloads.pause(id);
              pausedIds.push(id);
            } catch (e) {
              console.warn(`[下载] 暂停 downloadId=${id} 失败:`, e);
            }
          }
          console.log(`[下载] 暂停下载，已暂停 ${pausedIds.length} 个进行中的任务`);
          return { success: true };
        }

        case "RESUME_DOWNLOAD": {
          downloadState.isPaused = false;
          // 恢复被暂停的 Chrome 下载
          for (const id of activeDownloadIds) {
            try {
              await chrome.downloads.resume(id);
            } catch (e) {
              console.warn(`[下载] 恢复 downloadId=${id} 失败:`, e);
            }
          }
          console.log("[下载] 恢复下载");
          return { success: true };
        }

        case "CANCEL_DOWNLOAD": {
          downloadState.isCancelled = true;
          downloadState.isPaused = false;
          // 取消正在进行的 Chrome 下载
          for (const id of activeDownloadIds) {
            try {
              await chrome.downloads.cancel(id);
            } catch (e) {
              console.warn(`[下载] 取消 downloadId=${id} 失败:`, e);
            }
          }
          activeDownloadIds.clear();
          console.log("[下载] 取消下载");
          return { success: true };
        }

        case "GET_DOWNLOAD_STATE": {
          return { isPaused: downloadState.isPaused, isCancelled: downloadState.isCancelled };
        }

        default:
          return { success: false, error: "未知消息类型" };
      }
    } catch (error) {
      console.error("[Background] 处理消息失败:", error);
      return { success: false, error: error.message };
    }
  };

  handler().then(sendResponse);
  return true; // 保持消息通道开放
});

/**
 * 批量下载 - 完全复现 ima_download_tool 的存储逻辑
 */
async function batchDownload(headers, files, outputDir, concurrency = 3) {
  // 重置下载状态
  downloadState = { isPaused: false, isCancelled: false };
  
  // 清理输出目录名（防止特殊字符导致 Invalid filename）
  const safeOutputDir = sanitizeFileName(outputDir);
  console.log(`[下载] 输出目录: ${outputDir} -> ${safeOutputDir}`);
  
  const results = [];
  let completed = 0;
  let failed = 0;

  for (let i = 0; i < files.length; i += concurrency) {
    // 检查是否取消
    if (downloadState.isCancelled) {
      console.log("[下载] 用户取消下载");
      break;
    }

    // 检查是否暂停，等待恢复
    while (downloadState.isPaused && !downloadState.isCancelled) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // 暂停期间被取消
    if (downloadState.isCancelled) {
      console.log("[下载] 用户在暂停期间取消下载");
      break;
    }

    const batch = files.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(async (file) => {
        // 再次检查取消状态
        if (downloadState.isCancelled) {
          return { success: false, file, error: "用户取消" };
        }

        try {
          // 构造保存路径：使用 folderSegments 数组（精确）或从 path 解析（兼容旧缓存）
          let dirSegments = [];
          if (file.folderSegments && Array.isArray(file.folderSegments)) {
            // 对每个目录段单独清理，避免标题中的 / 被误认为路径分隔符
            dirSegments = file.folderSegments.map(s => sanitizeFileName(s)).filter(Boolean);
          } else if (file.path) {
            // 从 path 解析目录部分
            const filePath = file.path;
            const pathParts = filePath.split("/").filter(Boolean);
            if (pathParts.length > 1) {
              // 移除最后一段（文件名）
              pathParts.pop();
              dirSegments = pathParts.map(s => sanitizeFileName(s)).filter(Boolean);
            }
          }
          
          // 使用异步清理文件名（保留扩展名）
          const safeTitle = await sanitizeFileNameAsync(file.title);
          const fullPath = validateDownloadPath([safeOutputDir, ...dirSegments, safeTitle].join("/"));
          console.log(`[路径] title="${file.title}" dirSegments=[${dirSegments.join(", ")}] safeTitle="${safeTitle}" outputDir="${safeOutputDir}" -> ${fullPath}`);

          const result = await downloadFile(headers, file, fullPath);
          completed++;
          await markFileDownloaded(file, result);

          // 发送进度
          chrome.runtime.sendMessage({
            type: "DOWNLOAD_PROGRESS",
            completed,
            failed,
            total: files.length,
            currentFile: file.title
          }).catch(() => {});

          return {
            success: true,
            file: file,
            result: result
          };
        } catch (error) {
          failed++;
          await markFileFailed(file, error.message);
          console.error(`[下载失败] ${file.title}:`, error);

          // 发送进度
          chrome.runtime.sendMessage({
            type: "DOWNLOAD_PROGRESS",
            completed,
            failed,
            total: files.length,
            currentFile: file.title,
            error: error.message
          }).catch(() => {});

          return {
            success: false,
            file: file,
            error: error.message
          };
        }
      })
    );

    results.push(...batchResults);
  }

  return results;
}

/**
 * 构造安全路径 - 完全复现 ima_download_tool 的逻辑
 */
async function buildSafePath(path) {
  if (!path || !path.trim()) return "";

  const parts = path.split("/").filter(Boolean);
  const processed = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    // 最后一段使用异步清理（保留扩展名），其他段使用同步清理
    processed.push(isLast ? await sanitizeFileNameAsync(part) : sanitizeFileName(part));
  }

  return processed.filter(Boolean).join("/");
}

/**
 * 获取或创建 IMA 标签页
 */
async function getOrCreateImaTab() {
  // 查找已存在的 IMA 标签页
  const tabs = await chrome.tabs.query({ url: "*://ima.qq.com/*" });
  if (tabs.length > 0) {
    return tabs[0];
  }

  // 创建新的 IMA 标签页
  const tab = await chrome.tabs.create({ url: "https://ima.qq.com", active: false });

  // 等待页面加载完成
  await new Promise((resolve) => {
    const listener = (tabId, changeInfo) => {
      if (tabId === tab.id && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  // 等待一下确保 content script 加载
  await new Promise(resolve => setTimeout(resolve, 1000));

  return tab;
}

// ============ 扩展图标点击 - 打开独立窗口 ============

let popupWindowId = null;

chrome.action.onClicked.addListener(async () => {
  // 如果已有窗口且仍然存在，聚焦到该窗口
  if (popupWindowId !== null) {
    try {
      const win = await chrome.windows.get(popupWindowId);
      if (win) {
        chrome.windows.update(popupWindowId, { focused: true });
        return;
      }
    } catch (e) {
      // 窗口已关闭，重新创建
      popupWindowId = null;
    }
  }

  // 创建新的独立窗口
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html"),
    type: "popup",
    width: 480,
    height: 700
  });
  popupWindowId = win.id;
});

// 监听窗口关闭，清理 ID
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) {
    popupWindowId = null;
  }
});

console.log("[IMA 下载工具] Background service worker 已启动");
