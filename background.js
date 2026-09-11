// ===== 默认设置（文章版） =====

const DEFAULT_PRESET_PROMPTS = [
  "总结这篇文章的核心论点",
  "把文章整理成结构化笔记",
  "提取文章里可执行的行动建议"
];
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

const DEFAULT_SYNC_SETTINGS = {
  aiSystemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
  aiInitialQuickPrompts: DEFAULT_INITIAL_QUICK_PROMPTS.slice(),
  aiPresetPrompts: DEFAULT_PRESET_PROMPTS.slice()
};

// ===== AI 平台存储 =====

const AI_PROVIDER_KEYS_STORAGE = "aiProviderKeys";

function toString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeAiSystemPrompt(value) {
  return toString(value).trim();
}

function normalizeAiPresetPrompts(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => toString(item).trim())
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeAiInitialQuickPrompts(value) {
  if (!Array.isArray(value)) {
    return DEFAULT_INITIAL_QUICK_PROMPTS.slice();
  }
  return value
    .map((item) => toString(item).trim())
    .filter(Boolean)
    .slice(0, 4);
}

function normalizeAiProvider(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "").trim();
  if (!id) return null;
  return {
    id,
    presetId: String(item.presetId || "custom"),
    name: String(item.name || "自定义").trim() || "自定义",
    baseUrl: String(item.baseUrl || "").trim().replace(/\/+$/, ""),
    model: String(item.model || "").trim(),
    temperature: typeof item.temperature === "number" ? item.temperature : 0.7,
    requiresKey: item.requiresKey !== false,
    enabled: item.enabled !== false
  };
}

async function loadAiProviderKeys() {
  const data = await chrome.storage.local.get([AI_PROVIDER_KEYS_STORAGE]);
  return data?.[AI_PROVIDER_KEYS_STORAGE] && typeof data[AI_PROVIDER_KEYS_STORAGE] === "object"
    ? data[AI_PROVIDER_KEYS_STORAGE]
    : {};
}

async function saveAiProviderKey(providerId, apiKey) {
  const keys = await loadAiProviderKeys();
  const trimmed = toString(apiKey).trim().replace(/^Bearer\s+/i, "").trim();
  if (trimmed) {
    keys[providerId] = trimmed;
  } else {
    delete keys[providerId];
  }
  await chrome.storage.local.set({ [AI_PROVIDER_KEYS_STORAGE]: keys });
}

async function loadAiProviders() {
  const [syncData, keys] = await Promise.all([
    chrome.storage.sync.get(["aiProviders"]),
    loadAiProviderKeys()
  ]);
  const list = Array.isArray(syncData.aiProviders) ? syncData.aiProviders : [];
  return list
    .map(normalizeAiProvider)
    .filter(Boolean)
    .map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
}

async function saveAiProviders(items) {
  const rawList = Array.isArray(items) ? items : [];
  const keys = await loadAiProviderKeys();
  const nextList = [];
  for (const raw of rawList) {
    const normalized = normalizeAiProvider(raw);
    if (!normalized) continue;
    nextList.push(normalized);
    const incomingKey = String(raw?.apiKey || "").trim();
    if (incomingKey) {
      keys[normalized.id] = incomingKey.trim().replace(/^Bearer\s+/i, "").trim();
    }
  }
  await Promise.all([
    chrome.storage.sync.set({ aiProviders: nextList }),
    chrome.storage.local.set({ [AI_PROVIDER_KEYS_STORAGE]: keys })
  ]);
  return nextList.map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
}

async function deleteAiProvider(providerId) {
  const list = await loadAiProviders();
  const next = list.filter((p) => p.id !== providerId);
  const keys = await loadAiProviderKeys();
  delete keys[providerId];
  await Promise.all([
    chrome.storage.sync.set({ aiProviders: next }),
    chrome.storage.local.set({ [AI_PROVIDER_KEYS_STORAGE]: keys })
  ]);
  return next.map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
}

async function testAiConnection({ baseUrl, apiKey, model }) {
  const url = `${String(baseUrl || "").trim().replace(/\/+$/, "")}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: String(model || "").trim(),
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
        stream: false
      })
    });
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.text()).slice(0, 200); } catch {}
      return { ok: false, error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `网络错误：${error?.message || error}` };
  }
}

// ===== 设置读写 =====

async function initializeSettingsStorage() {
  const syncCurrent = await chrome.storage.sync.get(DEFAULT_SYNC_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SYNC_SETTINGS, ...syncCurrent });
}

async function getMergedSettings() {
  const syncSettings = await chrome.storage.sync.get(DEFAULT_SYNC_SETTINGS);
  const merged = { ...DEFAULT_SYNC_SETTINGS, ...syncSettings };
  merged.aiSystemPrompt = normalizeAiSystemPrompt(merged.aiSystemPrompt);
  merged.aiInitialQuickPrompts = normalizeAiInitialQuickPrompts(merged.aiInitialQuickPrompts);
  merged.aiPresetPrompts = normalizeAiPresetPrompts(merged.aiPresetPrompts);
  return merged;
}

async function saveSettings(settings) {
  const payload = settings && typeof settings === "object" ? settings : {};
  const syncPayload = {
    aiSystemPrompt: normalizeAiSystemPrompt(payload.aiSystemPrompt),
    aiInitialQuickPrompts: normalizeAiInitialQuickPrompts(payload.aiInitialQuickPrompts),
    aiPresetPrompts: normalizeAiPresetPrompts(payload.aiPresetPrompts)
  };
  await chrome.storage.sync.set(syncPayload);
}

// ===== 文章上下文 =====

function isSupportedArticleUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    // 仅支持可通过内容脚本提取正文的 http/https 页面；chrome:// 等内部页无法注入
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function buildEmptyContextPayload(tab) {
  return {
    title: String(tab?.title || "").trim(),
    url: String(tab?.url || "").trim(),
    accountName: "",
    author: "",
    publishDate: "",
    articleMarkdown: "",
    wordCount: 0,
    isArticleContext: false
  };
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

async function ensureContentScriptReady(tabId) {
  if (!chrome.scripting) {
    throw new Error("请刷新浏览器网页重试");
  }
  try {
    const probe = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__WAS_CONTENT_SCRIPT_LOADED__ || ""
    });
    const loadedVersion = String(probe?.[0]?.result || "");
    if (loadedVersion === (chrome.runtime.getManifest().version || "")) {
      return;
    }
  } catch {
    // 内容脚本未注入，继续走注入流程
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

async function fetchArticleContextFromTab(tabId) {
  await ensureContentScriptReady(tabId);
  const contextResp = await sendMessageToTab(tabId, { type: "sidepanel-get-context" });
  if (!contextResp?.ok || !contextResp?.payload) {
    throw new Error(contextResp?.error || "当前页面上下文读取失败");
  }
  return contextResp.payload;
}

async function getAiSidepanelState(tabId, { forceRefresh = false } = {}) {
  if (!tabId) {
    throw new Error("缺少标签页信息");
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id) {
    throw new Error("找不到当前标签页。");
  }

  if (!isSupportedArticleUrl(tab.url)) {
    return buildEmptyContextPayload(tab);
  }

  try {
    return await fetchArticleContextFromTab(tab.id);
  } catch (error) {
    const message = String(error?.message || "");
    // 页面内无法识别为文章：降级为无上下文模式
    if (message.includes("当前页面不是可识别的文章页")) {
      return buildEmptyContextPayload(tab);
    }
    // 内容脚本可能未就绪（刚装好扩展/页面太老），重试一次
    if (!forceRefresh) {
      await sleep(300);
      return await fetchArticleContextFromTab(tab.id);
    }
    throw error;
  }
}

async function resolveAiSidepanelContext(contextRef) {
  const refUrl = String(contextRef?.url || "").trim();
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0] || null;
  if (!tab?.id) {
    throw new Error("找不到当前标签页。");
  }

  if (refUrl && isSupportedArticleUrl(tab.url) && sameArticleUrl(tab.url, refUrl)) {
    return await fetchArticleContextFromTab(tab.id);
  }
  throw new Error("请先打开原文章页面再继续该对话。");
}

function sameArticleUrl(urlA, urlB) {
  const normalize = (value) => {
    try {
      const parsed = new URL(String(value || ""));
      parsed.hash = "";
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return String(value || "").trim();
    }
  };
  return normalize(urlA) === normalize(urlB) && Boolean(normalize(urlA));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===== AI 消息组装 =====

function buildAiMessages({ context, userPrompt, history, systemPrompt }) {
  const ctx = context || {};
  const hasArticleContext = Boolean(ctx.isArticleContext);
  const sections = hasArticleContext
    ? [
        `你是一个专业的网页文章阅读助手。当前用户正在阅读一篇网页文章，标题：「${ctx.title || "未知"}」`,
        `来源：${ctx.accountName || "未知"} | 作者：${ctx.author || "未知"} | 发布日期：${ctx.publishDate || "未知"} | 原文链接：${ctx.url || "未知"}`
      ]
    : [
        "你是一个通用 AI 助手。",
        "当前对话没有文章上下文，请仅基于用户消息和历史对话回答。"
      ];

  if (ctx.articleMarkdown) {
    sections.push(`以下是文章正文全文：\n\n${ctx.articleMarkdown}`);
  } else if (hasArticleContext) {
    sections.push("（未能提取到文章正文）");
  }

  const customSystemPrompt = normalizeAiSystemPrompt(systemPrompt);
  if (customSystemPrompt) {
    sections.push(`以下是额外系统要求：\n${customSystemPrompt}`);
  }

  return [
    { role: "system", content: sections.join("\n\n") },
    ...(Array.isArray(history)
      ? history.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      : []),
    { role: "user", content: String(userPrompt || "") }
  ];
}

function clipArticleMarkdown(markdown, maxChars = 40000) {
  const text = String(markdown || "");
  if (!text || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n...（文章过长，已截断）`;
}

async function* parseOpenAISSE(response) {
  if (!response || !response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.length ? lines.pop() : "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      if (!data) continue;
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta?.content;
        if (delta) yield String(delta);
      } catch {}
    }
  }
}

const STREAM_FIRST_TOKEN_TIMEOUT_MS = 90000;

async function streamChat({ provider, context, userPrompt, history, port, signal, getAbortMeta, onFirstToken }) {
  if (!port) return;
  const baseUrl = String(provider?.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    port.postMessage({ type: "error", error: "baseUrl 未配置" });
    return;
  }
  if (!provider.model) {
    port.postMessage({ type: "error", error: "模型未配置" });
    return;
  }

  const messages = buildAiMessages({
    context: { ...context, articleMarkdown: clipArticleMarkdown(context?.articleMarkdown) },
    userPrompt,
    history,
    systemPrompt: context?.aiSystemPrompt || ""
  });

  const headers = { "Content-Type": "application/json" };
  if (provider.apiKey) {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
  }

  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: provider.model,
        messages,
        stream: true,
        temperature: typeof provider.temperature === "number" ? provider.temperature : 0.7
      })
    });
  } catch (e) {
    if (getAbortMeta?.()?.type === "stopped") {
      port.postMessage({ type: "stopped", reason: "已停止生成" });
    } else {
      port.postMessage({ type: "error", error: `网络错误：${e?.message || e}` });
    }
    return;
  }

  if (!response.ok) {
    let detail = "";
    try { detail = (await response.text()).slice(0, 200); } catch {}
    port.postMessage({ type: "error", error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` });
    return;
  }

  try {
    let hasSentFirstToken = false;
    for await (const token of parseOpenAISSE(response)) {
      if (!hasSentFirstToken) {
        hasSentFirstToken = true;
        onFirstToken?.();
      }
      if (getAbortMeta?.()?.type === "stopped") {
        port.postMessage({ type: "stopped", reason: "已停止生成" });
        return;
      }
      port.postMessage({ type: "token", data: token });
    }
    port.postMessage({ type: "done" });
  } catch (e) {
    if (getAbortMeta?.()?.type === "stopped") {
      port.postMessage({ type: "stopped", reason: "已停止生成" });
    } else {
      port.postMessage({ type: "error", error: `读取响应失败：${e?.message || e}` });
    }
  }
}

// ===== 消息路由 =====

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "get-settings") {
    getMergedSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "save-settings") {
    saveSettings(message.settings || {})
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "open-options") {
    chrome.runtime
      .openOptionsPage()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-providers-list") {
    loadAiProviders()
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-providers-save") {
    saveAiProviders(message.providers || [])
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-provider-set-key") {
    saveAiProviderKey(String(message.providerId || ""), String(message.apiKey || ""))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-providers-delete") {
    deleteAiProvider(String(message.providerId || ""))
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-providers-test") {
    const baseUrl = String(message.baseUrl || "").trim();
    const providerId = String(message.providerId || "").trim();
    const model = String(message.model || "").trim();
    if (!baseUrl) {
      sendResponse({ ok: false, error: "请填写 baseUrl" });
      return false;
    }
    Promise.resolve()
      .then(async () => {
        const directApiKey = String(message.apiKey || "").trim();
        if (directApiKey) {
          return directApiKey;
        }
        if (!providerId) {
          return "";
        }
        const keys = await loadAiProviderKeys();
        return String(keys[providerId] || "").trim();
      })
      .then((apiKey) => testAiConnection({ baseUrl, apiKey, model }))
      .then((resp) => sendResponse(resp))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-sidepanel-get-state") {
    const tabId = Number(message.tabId || 0) || 0;
    const forceRefresh = message.forceRefresh === true;
    getAiSidepanelState(tabId, { forceRefresh })
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-sidepanel-resolve-context") {
    resolveAiSidepanelContext(message.contextRef || {})
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

// ===== 侧边栏对话流式通道 =====

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== "sidepanel-chat") {
    return;
  }

  let activeAbortController = null;
  let activeAbortMeta = null;
  let firstTokenTimeoutId = 0;

  const clearActiveRequestState = () => {
    if (firstTokenTimeoutId) {
      clearTimeout(firstTokenTimeoutId);
      firstTokenTimeoutId = 0;
    }
    activeAbortController = null;
    activeAbortMeta = null;
  };

  const abortActiveRequest = (meta = null) => {
    activeAbortMeta = meta;
    if (firstTokenTimeoutId) {
      clearTimeout(firstTokenTimeoutId);
      firstTokenTimeoutId = 0;
    }
    if (activeAbortController && !activeAbortController.signal.aborted) {
      activeAbortController.abort();
    }
  };

  const getAbortMeta = () => activeAbortMeta;

  port.onDisconnect.addListener(() => {
    abortActiveRequest({ type: "silent" });
    clearActiveRequestState();
  });

  port.onMessage.addListener(async (msg) => {
    if (!msg) return;
    if (msg.action === "stop") {
      abortActiveRequest({ type: "stopped", reason: "已停止生成" });
      return;
    }
    if (msg.action !== "chat") return;

    try {
      abortActiveRequest({ type: "silent" });
      clearActiveRequestState();
      activeAbortController = new AbortController();
      firstTokenTimeoutId = setTimeout(() => {
        abortActiveRequest({ type: "timeout", reason: "请求超时（90 秒未返回），已自动中断" });
      }, STREAM_FIRST_TOKEN_TIMEOUT_MS);
      const providers = await loadAiProviders();
      const provider = providers.find((p) => p.id === msg.providerId);
      if (!provider) {
        port.postMessage({ type: "error", error: "未找到选中的平台" });
        clearActiveRequestState();
        return;
      }
      const keys = await loadAiProviderKeys();
      const apiKey = keys[provider.id] || "";
      if (provider.requiresKey !== false && !apiKey) {
        port.postMessage({ type: "error", error: "该平台 API Key 未配置" });
        clearActiveRequestState();
        return;
      }
      await streamChat({
        provider: { ...provider, apiKey },
        context: msg.context || {},
        userPrompt: msg.prompt || "",
        history: Array.isArray(msg.history) ? msg.history : [],
        port,
        signal: activeAbortController.signal,
        getAbortMeta,
        onFirstToken: () => {
          if (firstTokenTimeoutId) {
            clearTimeout(firstTokenTimeoutId);
            firstTokenTimeoutId = 0;
          }
        }
      });
    } catch (e) {
      port.postMessage({ type: "error", error: String(e?.message || e) });
    } finally {
      clearActiveRequestState();
    }
  });
});

// ===== 点击插件图标直接打开侧边栏 =====

chrome.runtime.onInstalled.addListener(async () => {
  await initializeSettingsStorage();
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {}
});

try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} catch {}

initializeSettingsStorage().catch(() => {});
