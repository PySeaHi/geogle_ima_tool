# Debug Session: download-pause-filename

## 症状（用户报告）
1. 无法暂停下载
2. 下载文件未存储到指定目录
3. 所有文件名全为 "下载.pdf"

## 环境
- Chrome MV3 扩展（service worker）
- Windows，downloads/storage 权限已具备
- 对照组：`f:\Other_utils\ima_download_tool` 可正常存储（中文文件名正确、子目录正确）

## 假设（Hypotheses）
- H1（暂停）: `downloadState.isPaused` 只在批与批之间检查，且从未调用 `chrome.downloads.pause(id)`，导致对进行中的下载无效。
- H2（目录）: `showDirectoryPicker()` 仅取了文件夹名作为相对子目录，`chrome.downloads.download` 实际保存到浏览器"下载"目录；当文件名断裂时子目录也不会建立。
- H3（文件名）: 传给 `chrome.downloads.download({filename})` 的路径在运行时为空/被覆盖，Chrome 回退到服务器 Content-Disposition（"下载.pdf"）。
- H4（文件名）: `file.title` 在下载时为空/undefined（扫描结果标题字段缺失或缓存陈旧）。
- H5（文件名）: `jump_url` 提取逻辑浅层取值，未命中嵌套对象，导致 URL 异常。

## 证据状态
- progress_status: in_progress
- 证据目录: 使用项目现有 console 日志（service worker 控制台）

## 结论
- 待运行时证据确认。