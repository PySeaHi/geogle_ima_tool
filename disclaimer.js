// 免责声明页面逻辑

document.addEventListener("DOMContentLoaded", () => {
  const checkbox = document.getElementById("agree-checkbox");
  const agreeBtn = document.getElementById("agree-btn");

  // 复选框状态变化
  checkbox.addEventListener("change", () => {
    agreeBtn.disabled = !checkbox.checked;
  });

  // 同意按钮点击
  agreeBtn.addEventListener("click", async () => {
    if (!checkbox.checked) return;

    try {
      // 保存同意状态到 Chrome storage
      await chrome.storage.local.set({ disclaimer_agreed: true });
      
      // 跳转到主页面
      window.location.href = "popup.html";
    } catch (error) {
      console.error("保存同意状态失败:", error);
      alert("保存失败，请重试");
    }
  });
});
