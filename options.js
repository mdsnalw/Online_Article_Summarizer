const DEFAULT_INITIAL_QUICK_PROMPTS = [
  "用 3 句话总结这篇文章",
  "提炼这篇文章的 5 个重点",
  "列出文章的行动建议",
  "文章里有哪些值得引用的金句"
];
const DEFAULT_AI_SYSTEM_PROMPT = [
  "你是一名专业的文章内容分析助手。",
  "基于用户提供的网页文章全文提炼高价值信息，不要复述原文，不要输出思考过程或 think 标签。",
  "优先输出：主题与核心观点、关键数据与事实、论证逻辑、结论与可执行建议。",
  "回答应结构化、信息密度高、便于收藏和复习，可适当使用 Emoji、列表和表格。",
  "自动过滤广告、废话和重复表达。",
  "信息不足时明确说明，不得猜测或编造；涉及专业内容时，区分事实、数据、推测与作者观点。"
].join("\n");

const DEFAULT_SETTINGS = {
  aiSystemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
  aiInitialQuickPrompts: DEFAULT_INITIAL_QUICK_PROMPTS.slice(),
  aiPresetPrompts: []
};

const AI_PRESETS = [
  { id: "openai_compat", name: "OpenAI 兼容", baseUrl: "https://api.openai.com/v1", requiresKey: true },
  { id: "deepseek",      name: "DeepSeek",    baseUrl: "https://api.deepseek.com/v1", requiresKey: true },
  { id: "zhipu",         name: "智谱 GLM",    baseUrl: "https://open.bigmodel.cn/api/paas/v4", requiresKey: true },
  { id: "minimax",       name: "MiniMax",     baseUrl: "https://api.minimaxi.com/v1", requiresKey: true },
  { id: "moonshot",      name: "Moonshot",    baseUrl: "https://api.moonshot.cn/v1", requiresKey: true },
  { id: "openrouter",    name: "OpenRouter",  baseUrl: "https://openrouter.ai/api/v1", requiresKey: true },
  { id: "ollama",        name: "Ollama (本地)", baseUrl: "http://localhost:11434/v1", requiresKey: false },
  { id: "custom",        name: "自定义",      baseUrl: "", requiresKey: true }
];

const elements = {
  aiProvidersList: document.getElementById("aiProvidersList"),
  aiProvidersEmpty: document.getElementById("aiProvidersEmpty"),
  addAiProviderBtn: document.getElementById("addAiProviderBtn"),
  aiSystemPrompt: document.getElementById("aiSystemPrompt"),
  aiInitialQuickPrompts: document.querySelectorAll(".ai-initial-quick-prompt"),
  saveBtn: document.getElementById("saveBtn"),
  status: document.getElementById("status")
};

init();

function init() {
  loadSettings();
  elements.saveBtn.addEventListener("click", saveSettings);
  elements.addAiProviderBtn.addEventListener("click", () => addAiProviderRow());
}

async function loadSettings() {
  const settings = await getSettings();
  elements.aiSystemPrompt.value = settings.aiSystemPrompt || "";
  renderInitialQuickPromptInputs(settings.aiInitialQuickPrompts);

  const providers = await loadAiProviders();
  renderAiProviders(providers);
}

async function saveSettings() {
  const payload = {
    aiSystemPrompt: String(elements.aiSystemPrompt?.value || "").trim(),
    aiInitialQuickPrompts: collectInitialQuickPrompts()
  };
  const aiProvidersPayload = collectAiProviders();
  const aiProvidersValidation = validateAiProviders(aiProvidersPayload);
  if (!aiProvidersValidation.ok) {
    setStatus(aiProvidersValidation.message || "AI 平台配置有误", true);
    return;
  }

  setBusy(true);
  try {
    const resp = await sendRuntimeMessage({ type: "save-settings", settings: payload });
    if (!resp?.ok) {
      setStatus(resp?.error || "保存失败", true);
      return;
    }

    const aiResp = await sendRuntimeMessage({ type: "ai-providers-save", providers: aiProvidersPayload });
    if (!aiResp?.ok) {
      setStatus(`已保存，但 AI 平台保存失败：${aiResp?.error || "未知错误"}`, true);
      return;
    }
    renderAiProviders(aiResp.providers || []);
    setStatus("保存成功");
  } catch (error) {
    setStatus(error.message || "保存失败", true);
  } finally {
    setBusy(false);
  }
}

async function getSettings() {
  try {
    const resp = await sendRuntimeMessage({ type: "get-settings" });
    if (!resp?.ok) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...(resp.settings || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function setStatus(text, isError = false) {
  elements.status.textContent = text;
  elements.status.dataset.error = isError ? "true" : "false";
}

function renderInitialQuickPromptInputs(value) {
  const prompts = Array.isArray(value) ? value : DEFAULT_INITIAL_QUICK_PROMPTS;
  elements.aiInitialQuickPrompts.forEach((input, index) => {
    input.value = String(prompts[index] || "");
  });
}

function collectInitialQuickPrompts() {
  return Array.from(elements.aiInitialQuickPrompts || [])
    .map((input) => String(input.value || "").trim())
    .slice(0, 4);
}

function setBusy(isBusy) {
  elements.saveBtn.disabled = isBusy;
  elements.saveBtn.textContent = isBusy ? "处理中..." : "保存设置";
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

// ===== AI 模型平台 =====

async function loadAiProviders() {
  try {
    const resp = await sendRuntimeMessage({ type: "ai-providers-list" });
    if (!resp?.ok) return [];
    return Array.isArray(resp.providers) ? resp.providers : [];
  } catch {
    return [];
  }
}

function renderAiProviders(items) {
  elements.aiProvidersList.innerHTML = "";
  const list = Array.isArray(items) ? items : [];
  list.forEach((item) => addAiProviderRow(item));
  updateAiProvidersEmptyState();
}

function updateAiProvidersEmptyState() {
  const hasRows = elements.aiProvidersList.children.length > 0;
  elements.aiProvidersEmpty.hidden = hasRows;
}

function generateAiProviderId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function addAiProviderRow(item = {}) {
  const id = String(item.id || generateAiProviderId());
  const presetId = String(item.presetId || "custom");
  const preset = AI_PRESETS.find((p) => p.id === presetId) || AI_PRESETS[AI_PRESETS.length - 1];
  const baseUrl = String(item.baseUrl ?? preset.baseUrl ?? "");
  const model = String(item.model || "");
  const requiresKey = item.requiresKey !== false && preset.requiresKey !== false;
  const hasSavedKey = Boolean(item.hasSavedKey);

  const row = document.createElement("div");
  row.className = "ai-provider-row";
  row.dataset.providerId = id;
  row.dataset.hasSavedKey = hasSavedKey ? "1" : "0";
  row.dataset.currentPresetId = presetId;
  row.innerHTML = `
    <select class="ai-provider-preset" title="平台">
      ${AI_PRESETS.map((p) => `<option value="${escapeAttribute(p.id)}" ${p.id === presetId ? "selected" : ""}>${escapeAttribute(p.name)}</option>`).join("")}
    </select>
    <input class="ai-provider-baseurl" type="text" placeholder="baseUrl（如 https://api.openai.com/v1）" value="${escapeAttribute(baseUrl)}" />
    <input class="ai-provider-model" type="text" placeholder="模型名（如 gpt-4o-mini）" value="${escapeAttribute(model)}" />
    <input class="ai-provider-apikey" type="password" placeholder="${hasSavedKey ? "已保存" : (requiresKey ? "API Key" : "API Key（可选）")}" autocomplete="off" />
    <button type="button" class="secondary-btn ai-provider-test">测试</button>
    <button type="button" class="ai-provider-remove" aria-label="删除" title="删除">
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <path d="M4 7h16"></path>
        <path d="M9 3h6"></path>
        <path d="M10 11v6"></path>
        <path d="M14 11v6"></path>
        <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>
      </svg>
    </button>
    <p class="ai-provider-status" hidden></p>
  `;

  row.querySelector(".ai-provider-preset").addEventListener("change", (e) => {
    const previousPreset = AI_PRESETS.find((p) => p.id === row.dataset.currentPresetId) || null;
    const next = AI_PRESETS.find((p) => p.id === e.target.value);
    if (!next) return;
    const baseUrlInput = row.querySelector(".ai-provider-baseurl");
    const currentBaseUrl = baseUrlInput.value.trim();
    if (!currentBaseUrl || (previousPreset && currentBaseUrl === previousPreset.baseUrl)) {
      baseUrlInput.value = next.baseUrl;
    }
    const apikeyInput = row.querySelector(".ai-provider-apikey");
    apikeyInput.placeholder = row.dataset.hasSavedKey === "1"
      ? "已保存"
      : (next.requiresKey ? "API Key" : "API Key（可选）");
    row.dataset.currentPresetId = next.id;
  });

  row.querySelector(".ai-provider-remove")?.addEventListener("click", async () => {
    if (!confirm("确定要删除这个平台吗？")) return;
    if (row.dataset.providerId) {
      try {
        await sendRuntimeMessage({ type: "ai-providers-delete", providerId: row.dataset.providerId });
      } catch {}
    }
    row.remove();
    updateAiProvidersEmptyState();
  });

  row.querySelector(".ai-provider-test")?.addEventListener("click", async () => {
    const statusNode = row.querySelector(".ai-provider-status");
    const baseUrl = row.querySelector(".ai-provider-baseurl").value.trim();
    const apiKey = row.querySelector(".ai-provider-apikey").value.trim();
    const model = row.querySelector(".ai-provider-model").value.trim();
    if (!baseUrl) {
      showAiProviderStatus(statusNode, "请填写 baseUrl", true);
      return;
    }
    if (!model) {
      showAiProviderStatus(statusNode, "请填写模型名", true);
      return;
    }
    showAiProviderStatus(statusNode, "正在测试...");
    const resp = await sendRuntimeMessage({
      type: "ai-providers-test",
      providerId: row.dataset.providerId || "",
      baseUrl,
      apiKey,
      model
    });
    if (resp?.ok) {
      showAiProviderStatus(statusNode, "连接成功");
    } else {
      showAiProviderStatus(statusNode, `失败：${resp?.error || "未知错误"}`, true);
    }
  });

  elements.aiProvidersList.appendChild(row);
  updateAiProvidersEmptyState();
}

function showAiProviderStatus(node, text, isError = false) {
  if (!node) return;
  node.hidden = false;
  node.textContent = text;
  node.dataset.error = isError ? "true" : "false";
}

function collectAiProviders() {
  return Array.from(elements.aiProvidersList.querySelectorAll(".ai-provider-row")).map((row) => {
    const presetSelect = row.querySelector(".ai-provider-preset");
    const preset = AI_PRESETS.find((p) => p.id === presetSelect.value) || AI_PRESETS[AI_PRESETS.length - 1];
    const apiKey = row.querySelector(".ai-provider-apikey").value.trim();
    const baseUrl = row.querySelector(".ai-provider-baseurl").value.trim().replace(/\/+$/, "");
    return {
      id: row.dataset.providerId || generateAiProviderId(),
      presetId: preset.id,
      name: preset.name,
      baseUrl,
      model: row.querySelector(".ai-provider-model").value.trim(),
      temperature: 0.7,
      requiresKey: preset.requiresKey,
      enabled: true,
      apiKey,
      hasSavedKey: row.dataset.hasSavedKey === "1"
    };
  });
}

function validateAiProviders(items) {
  const seenIds = new Set();
  for (const item of items) {
    if (!item.baseUrl) {
      return { ok: false, message: "每个平台都需要填写 baseUrl" };
    }
    try {
      const u = new URL(item.baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return { ok: false, message: `baseUrl 必须以 http(s):// 开头（${item.baseUrl}）` };
      }
    } catch {
      return { ok: false, message: `baseUrl 格式不正确：${item.baseUrl}` };
    }
    if (item.requiresKey && !item.apiKey && !item.hasSavedKey) {
      return { ok: false, message: `平台「${item.name}」需要填写 API Key` };
    }
    if (!item.model) {
      return { ok: false, message: `平台「${item.name}」需要填写模型名` };
    }
    if (seenIds.has(item.id)) {
      return { ok: false, message: "平台 id 重复，请刷新页面后重试" };
    }
    seenIds.add(item.id);
  }
  return { ok: true };
}

function escapeAttribute(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
