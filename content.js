// ============ IMA 下载工具 - Content Script ============
// 注入到 ima.qq.com 页面，用于获取登录态

console.log("[IMA 下载工具] Content script 已加载");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_ACCOUNT_INFO") {
    try {
      const accountInfo = getAccountInfo();
      if (!accountInfo) {
        sendResponse({ success: false, error: "未找到账号信息，请先登录 IMA" });
      } else {
        sendResponse({ success: true, data: accountInfo });
      }
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }
});

/**
 * 从 localStorage 获取账号信息
 */
function getAccountInfo() {
  const data = localStorage.getItem("ima-universal-local-storage-accountInfo");
  if (!data) return null;

  try {
    const parsed = JSON.parse(data);
    return {
      guid: parsed.guid || "",
      refreshToken: parsed.refreshToken || "",
      token: parsed.token || "",
      uid: parsed.uid || ""
    };
  } catch (error) {
    console.error("[IMA 下载工具] 解析账号信息失败:", error);
    return null;
  }
}
