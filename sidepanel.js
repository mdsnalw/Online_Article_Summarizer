const SELECTED_PROVIDER_KEY = "boc_ai_selected_provider";
const CONVERSATIONS_STORAGE_KEY = "boc_ai_conversations_v1";
const MAX_SAVED_CONVERSATIONS = 60;
const NON_VIDEO_CONTEXT_MESSAGE = "当前页面无法识别为文章，<br>未提取到正文作为对话上下文，<br>仅支持 AI 对话。";
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
const STREAM_SLOW_NOTICE_MS = 15000;

const els = {
  header: document.querySelector(".sp-header"),
  contextChip: document.getElementById("spContextChip"),
  refreshBtn: document.getElementById("spRefreshBtn"),
  modelSelect: document.getElementById("spModelSelect"),
  settingsBtn: document.getElementById("spSettingsBtn"),
  newChatBtn: document.getElementById("spNewChatBtn"),
  presetBtn: document.getElementById("spPresetBtn"),
  historyBtn: document.getElementById("spHistoryBtn"),
  presetPopover: document.getElementById("spPresetPopover"),
  presetList: document.getElementById("spPresetList"),
  presetInput: document.getElementById("spPresetInput"),
  presetAddBtn: document.getElementById("spPresetAddBtn"),
  historyPopover: document.getElementById("spHistoryPopover"),
  historyList: document.getElementById("spHistoryList"),
  historyClearBtn: document.getElementById("spHistoryClearBtn"),
  messages: document.getElementById("spMessages"),
  input: document.getElementById("spInput"),
  stopBtn: document.getElementById("spStopBtn"),
};

const DEFAULT_AI_PREFS = {
  aiSystemPrompt: "",
  aiInitialQuickPrompts: DEFAULT_INITIAL_QUICK_PROMPTS.slice(),
  aiPresetPrompts: DEFAULT_PRESET_PROMPTS.slice()
};

let contextData = null;
let currentContextKey = "";
let providers = [];
let activePort = null;
let activeAssistantNode = null;
let activeUserPrompt = "";
let chatHistory = [];
let suggestionsNode = null;
let aiPrefs = { ...DEFAULT_AI_PREFS };
let savedConversations = [];
let currentConversationId = "";
let currentConversationMeta = null;
let liveContextData = null;
let liveContextKey = "";
let liveTabUrl = "";
let contextNoticeTimer = 0;
let shouldAutoScrollMessages = true;
let liveContextSyncTimer = 0;
let liveContextSyncForceRefresh = false;
let modelSelectMeasureCanvas = null;
let streamSlowNoticeTimer = 0;
let streamFirstTokenReceived = false;
let initCompleted = false;
let presetErrorText = "";

init().catch((err) => {
  resetConversationView(`初始化失败：${escapeHtml(err?.message || err)}`);
});

async function init() {
  bindEvents();
  await loadProvidersAndPrefs();
  await loadSavedConversations();
  await loadContextState();
  await restoreLatestConversationForCurrentContext();
  renderInitialState();
  autosizeInput();
}

function bindEvents() {
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  els.input.addEventListener("input", autosizeInput);
  els.messages.addEventListener("scroll", () => {
    shouldAutoScrollMessages = isMessagesNearBottom();
  });
  els.settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.contextChip.addEventListener("click", () => {
    void openCurrentContextUrl();
  });
  els.newChatBtn.addEventListener("click", () => {
    void startNewConversation();
  });
  els.refreshBtn.addEventListener("click", () => refreshContextManually());
  els.presetBtn.addEventListener("click", togglePresetPopover);
  els.historyBtn.addEventListener("click", toggleHistoryPopover);
  els.historyClearBtn?.addEventListener("click", () => {
    void clearAllConversations();
  });
  els.stopBtn?.addEventListener("click", () => {
    stopActiveStream();
  });
  els.presetAddBtn.addEventListener("click", addPresetPrompt);
  els.presetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      addPresetPrompt();
    }
  });
  els.modelSelect.addEventListener("change", () => {
    if (els.modelSelect.value) {
      localStorage.setItem(SELECTED_PROVIDER_KEY, els.modelSelect.value);
    }
    updateModelSelectWidth();
  });
  window.addEventListener("resize", updateModelSelectWidth);
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleLiveContextSync(true);
    }
  });
  window.addEventListener("focus", () => {
    scheduleLiveContextSync(true);
  });
  chrome.tabs.onActivated.addListener(() => {
    scheduleLiveContextSync(true);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab?.active) {
      return;
    }
    if (!changeInfo.url && changeInfo.status !== "complete") {
      return;
    }
    scheduleLiveContextSync(Boolean(changeInfo.url));
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      (areaName === "sync" &&
        (changes.aiProviders || changes.aiSystemPrompt || changes.aiInitialQuickPrompts)) ||
      (areaName === "local" && (changes.aiProviderKeys || changes.aiPresetPrompts))
    ) {
      void refreshProvidersAndPrefsAfterExternalChange();
    }
  });
}

function autosizeInput() {
  els.input.style.height = "auto";
  const next = Math.min(els.input.scrollHeight, 320);
  const minHeight = document.body.classList.contains("sp-non-video-context") ? 72 : 94;
  els.input.style.height = `${Math.max(next, minHeight)}px`;
}

function setStreamingUiState(isStreaming, { stopping = false } = {}) {
  els.input.disabled = isStreaming;
  if (els.stopBtn) {
    els.stopBtn.hidden = !isStreaming;
    els.stopBtn.disabled = stopping;
    els.stopBtn.textContent = stopping ? "停止中..." : "停止";
  }
}

async function loadProvidersAndPrefs({ preferredProviderId = "" } = {}) {
  const [providersResp, settingsResp] = await Promise.all([
    sendRuntimeMessage({ type: "ai-providers-list" }),
    sendRuntimeMessage({ type: "get-settings" }).catch(() => ({ ok: false }))
  ]);
  providers = Array.isArray(providersResp?.providers)
    ? providersResp.providers.filter((p) => p.enabled)
    : [];
  aiPrefs = {
    aiSystemPrompt: String(settingsResp?.settings?.aiSystemPrompt || "").trim(),
    aiInitialQuickPrompts: normalizeInitialQuickPrompts(settingsResp?.settings?.aiInitialQuickPrompts),
    aiPresetPrompts: Array.isArray(settingsResp?.settings?.aiPresetPrompts)
      ? settingsResp.settings.aiPresetPrompts.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12)
      : []
  };
  if (!aiPrefs.aiPresetPrompts.length) {
    aiPrefs.aiPresetPrompts = DEFAULT_PRESET_PROMPTS.slice();
    void persistAiPresetPrompts();
  }
  renderModelSelect(preferredProviderId);
  renderPresetPrompts();
}

function renderModelSelect(preferredProviderId = "") {
  if (!providers.length) {
    els.modelSelect.innerHTML = '<option value="">未配置平台</option>';
    els.modelSelect.disabled = true;
    els.modelSelect.style.width = "96px";
    return;
  }

  els.modelSelect.innerHTML = providers
    .map((p) => {
      const label = String(p.model || p.name || "").trim();
      return `<option value="${escapeHtml(p.id)}">${escapeHtml(label)}</option>`;
    })
    .join("");

  const savedProviderId = String(preferredProviderId || localStorage.getItem(SELECTED_PROVIDER_KEY) || "").trim();
  const matchedProvider = providers.find((item) => item.id === savedProviderId) || providers[0];
  els.modelSelect.value = matchedProvider?.id || "";
  els.modelSelect.disabled = false;
  updateModelSelectWidth();
}

async function refreshProvidersAndPrefsAfterExternalChange() {
  const previousProviderId = String(els.modelSelect?.value || localStorage.getItem(SELECTED_PROVIDER_KEY) || "").trim();
  await loadProvidersAndPrefs({ preferredProviderId: previousProviderId });
  if (activePort) {
    return;
  }
  renderHistoryList();
  renderInitialState();
}

function updateModelSelectWidth() {
  if (!els.modelSelect) {
    return;
  }
  const selectedOption = els.modelSelect.options[els.modelSelect.selectedIndex];
  const text = String(selectedOption?.textContent || "").trim() || "未配置平台";
  const computedStyle = window.getComputedStyle(els.modelSelect);
  const measuredTextWidth = measureTextWidth(text, computedStyle);
  const extraCharsWidth = measureTextWidth("000", computedStyle);
  const desiredWidth = Math.ceil(measuredTextWidth + extraCharsWidth + 36);
  const minWidth = 92;
  const maxWidth = getModelSelectMaxWidth();
  const nextWidth = Math.max(minWidth, Math.min(desiredWidth, maxWidth));
  els.modelSelect.style.width = `${nextWidth}px`;
}

function measureTextWidth(text, style) {
  if (!modelSelectMeasureCanvas) {
    modelSelectMeasureCanvas = document.createElement("canvas");
  }
  const ctx = modelSelectMeasureCanvas.getContext("2d");
  if (!ctx) {
    return text.length * 8;
  }
  const fontStyle = style?.fontStyle || "normal";
  const fontVariant = style?.fontVariant || "normal";
  const fontWeight = style?.fontWeight || "400";
  const fontSize = style?.fontSize || "11px";
  const fontFamily = style?.fontFamily || "sans-serif";
  ctx.font = `${fontStyle} ${fontVariant} ${fontWeight} ${fontSize} ${fontFamily}`;
  return ctx.measureText(text).width;
}

function getModelSelectMaxWidth() {
  const header = els.header;
  if (!header || !els.contextChip || !els.refreshBtn || !els.settingsBtn) {
    return 172;
  }
  const style = window.getComputedStyle(header);
  const gap = Number.parseFloat(style.columnGap || style.gap || "0") || 0;
  const paddingLeft = Number.parseFloat(style.paddingLeft || "0") || 0;
  const paddingRight = Number.parseFloat(style.paddingRight || "0") || 0;
  const contentWidth = header.clientWidth - paddingLeft - paddingRight;
  const siblingWidth =
    els.contextChip.offsetWidth +
    els.refreshBtn.offsetWidth +
    els.settingsBtn.offsetWidth +
    gap * 3;
  return Math.max(92, Math.floor(contentWidth - siblingWidth));
}

async function loadContextState({ forceRefresh = false, silent = false } = {}) {
  const hasPinnedConversation = currentConversationMeta?.pinnedContext === true;
  const tab = await getActiveTab();
  if (!tab?.id) {
    liveContextData = null;
    liveContextKey = "";
    liveTabUrl = "";
    if (!hasPinnedConversation) {
      contextData = null;
      currentContextKey = "";
    }
    updateContextChip();
    if (!silent && !hasPinnedConversation) {
      resetConversationView("找不到当前标签页。");
    }
    return false;
  }

  const resp = await sendRuntimeMessage({
    type: "ai-sidepanel-get-state",
    tabId: tab.id,
    forceRefresh
  }).catch((error) => ({ ok: false, error: error.message }));
  liveTabUrl = String(tab.url || "").trim();

  if (!resp?.ok || !resp.payload) {
    liveContextData = null;
    liveContextKey = "";
    if (!hasPinnedConversation) {
      contextData = null;
      currentContextKey = "";
    }
    updateContextChip();
    if (!silent && !hasPinnedConversation) {
      resetConversationView(resp?.error || "当前页面上下文读取失败。");
    }
    return false;
  }

  liveContextData = resp.payload;
  liveContextKey = buildContextKey(resp.payload);
  if (hasPinnedConversation) {
    renderHistoryList();
    updateContextChip();
    return true;
  }

  const contextChanged = applyContextPayload(resp.payload);
  renderHistoryList();
  if (contextChanged) {
    await restoreLatestConversationForCurrentContext();
    renderInitialState();
  }
  return true;
}

function applyContextPayload(payload) {
  const nextContext = payload && typeof payload === "object" ? payload : null;
  const nextKey = buildContextKey(nextContext);
  const contextChanged = Boolean(currentContextKey && nextKey && nextKey !== currentContextKey);

  contextData = nextContext;
  currentContextKey = nextKey;
  updateContextChip();

  if (contextChanged) {
    restartChat({ keepContext: true });
  } else {
    renderSuggestions();
  }
  return contextChanged;
}

function buildContextKey(payload) {
  if (!payload) {
    return "";
  }
  const normalizedUrl = normalizeContextUrlForKey(payload.url);
  return normalizedUrl ? `url:${normalizedUrl}` : "";
}

function normalizeContextUrlForKey(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  try {
    const parsed = new URL(text);
    parsed.hash = "";
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return text;
  }
}

function updateContextChip() {
  if (!contextData) {
    els.contextChip.textContent = "无上下文";
    els.contextChip.title = "";
    els.contextChip.disabled = true;
    els.contextChip.classList.remove("is-mismatch");
    return;
  }

  const shortTitle = contextData.title ? truncate(contextData.title, 19) : "未知文章";
  els.contextChip.textContent = shortTitle;
  const mismatch = isBoundConversationMismatched();
  els.contextChip.classList.toggle("is-mismatch", mismatch);
  els.contextChip.title = contextData.url
    ? `${contextData.title || ""}${mismatch ? "\n当前页不是这个对话绑定的文章" : ""}\n点击跳转目标文章，或开启新对话`
    : contextData.title || "";
  els.contextChip.disabled = !String(contextData.url || "").trim();
}

function isBoundConversationMismatched() {
  if (currentConversationMeta?.pinnedContext !== true) {
    return false;
  }
  const targetUrl = String(currentConversationMeta?.contextUrl || contextData?.url || "").trim();
  if (!targetUrl) {
    return false;
  }
  if (!liveTabUrl) {
    return true;
  }
  return !doesTabMatchContextUrl(liveTabUrl, targetUrl);
}

async function openCurrentContextUrl() {
  const targetUrl = String(contextData?.url || currentConversationMeta?.contextUrl || "").trim();
  if (!targetUrl) {
    return;
  }
  const tab = await getActiveTab().catch(() => null);
  if (!tab?.id) {
    return;
  }
  try {
    const sameVideo = doesTabMatchContextUrl(tab.url || "", targetUrl);
    if (!sameVideo) {
      await chrome.tabs.update(tab.id, { url: targetUrl });
      await waitForTabComplete(tab.id);
    }
    await loadContextState({ forceRefresh: true, silent: true });
  } catch {}
}

function renderInitialState() {
  updateSidepanelLayoutState();
  if (!contextData) {
    resetConversationView("当前页面无法识别为文章正文，请在文章页打开侧边栏。");
    return;
  }
  if (!providers.length) {
    resetConversationView('还没有配置 AI 平台，<a href="#" id="spOpenSettings">前往设置</a>');
    document.getElementById("spOpenSettings")?.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    return;
  }
  if (chatHistory.length) {
    renderConversationMessages();
    return;
  }
  if (contextData.isArticleContext === false) {
    resetConversationView(NON_VIDEO_CONTEXT_MESSAGE);
    return;
  }
  resetConversationView("");
}

function resetConversationView(stateHtml = "") {
  updateSidepanelLayoutState();
  els.messages.innerHTML = "";
  if (stateHtml) {
    const stateNode = document.createElement("div");
    stateNode.className = "sp-center-error";
    stateNode.innerHTML = stateHtml;
    els.messages.appendChild(stateNode);
  }
  suggestionsNode = document.createElement("div");
  suggestionsNode.className = "sp-suggestions";
  suggestionsNode.id = "spSuggestions";
  els.messages.appendChild(suggestionsNode);
  renderSuggestions();
  renderPresetPrompts();
  shouldAutoScrollMessages = true;
  scrollToBottom(true);
}

function renderSuggestions() {
  if (!suggestionsNode) {
    return;
  }
  if (!contextData || !providers.length || chatHistory.length || contextData.isArticleContext === false) {
    suggestionsNode.innerHTML = "";
    return;
  }
  const prompts = normalizeInitialQuickPrompts(aiPrefs.aiInitialQuickPrompts).filter(Boolean);
  suggestionsNode.innerHTML = prompts
    .map((prompt) => `<button type="button" class="sp-chip">${escapeHtml(prompt)}</button>`)
    .join("");
  suggestionsNode.querySelectorAll(".sp-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.input.value = btn.textContent || "";
      autosizeInput();
      sendMessage();
    });
  });
}

function normalizeInitialQuickPrompts(value) {
  if (!Array.isArray(value)) {
    return DEFAULT_INITIAL_QUICK_PROMPTS.slice();
  }
  return value.map((item) => String(item || "").trim()).slice(0, 4);
}

function renderPresetPrompts() {
  if (!els.presetList) {
    return;
  }
  const prompts = Array.isArray(aiPrefs.aiPresetPrompts) ? aiPrefs.aiPresetPrompts : [];
  const errorHtml = presetErrorText
    ? `<span class="sp-msg-error">${escapeHtml(presetErrorText)}</span>`
    : "";
  if (!prompts.length) {
    els.presetList.innerHTML = `<span class="sp-preset-empty">还没有预设提示词</span>${errorHtml}`;
    return;
  }
  els.presetList.innerHTML = prompts
    .map((prompt, index) => `
      <span class="sp-preset-item">
        <button type="button" class="sp-preset-chip" data-index="${index}" title="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>
        <button type="button" class="sp-preset-remove" data-index="${index}" aria-label="删除预设提示词">×</button>
      </span>
    `)
    .join("") + errorHtml;
  els.presetList.querySelectorAll(".sp-preset-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const index = Number(btn.getAttribute("data-index") || -1);
      insertPresetPrompt(prompts[index] || "");
      hidePresetPopover();
    });
  });
  els.presetList.querySelectorAll(".sp-preset-remove").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const index = Number(btn.getAttribute("data-index") || -1);
      await removePresetPrompt(index);
    });
  });
}

function renderHistoryList() {
  if (!els.historyList) {
    return;
  }
  if (els.historyClearBtn) {
    els.historyClearBtn.hidden = savedConversations.length === 0;
  }
  if (!savedConversations.length) {
    els.historyList.innerHTML = '<span class="sp-history-empty">还没有历史对话</span>';
    return;
  }

  const liveArticleRef = liveContextData?.isArticleContext ? liveContextData : null;
  const canHighlightLiveMatches = Boolean(
    liveArticleRef &&
    currentConversationMeta?.pinnedContext &&
    currentConversationMeta?.contextUrl &&
    !doesTabMatchContextUrl(liveArticleRef.url || liveTabUrl, currentConversationMeta.contextUrl || "")
  );

  els.historyList.innerHTML = savedConversations
    .map((conversation) => {
      const isActive = conversation.id === currentConversationId;
      const isLiveMatch = Boolean(
        !isActive &&
        canHighlightLiveMatches &&
        doesConversationMatchCurrentContext(conversation, liveArticleRef, liveContextKey)
      );
      const metaText = formatConversationTimestamp(conversation.updatedAt || conversation.createdAt);
      const titleDisplay = buildConversationTitleDisplay(conversation.title, 30);
      return `
        <div class="sp-history-item ${isActive ? "is-active" : ""} ${isLiveMatch ? "is-live-match" : ""}" data-id="${escapeHtml(conversation.id)}">
          <button type="button" class="sp-history-open" data-id="${escapeHtml(conversation.id)}">
            <span class="sp-history-title" title="${escapeHtml(conversation.title)}">
              <span class="sp-history-title-main">${escapeHtml(titleDisplay.main)}</span>
              ${titleDisplay.suffix ? `<span class="sp-history-title-suffix">${escapeHtml(titleDisplay.suffix)}</span>` : ""}
            </span>
            <span class="sp-history-meta" title="${escapeHtml(metaText)}">${escapeHtml(metaText)}</span>
          </button>
          <button type="button" class="sp-history-remove" data-id="${escapeHtml(conversation.id)}" aria-label="删除历史对话">×</button>
        </div>
      `;
    })
    .join("");

  els.historyList.querySelectorAll(".sp-history-open").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = String(btn.getAttribute("data-id") || "");
      loadConversationById(id);
      hideHistoryPopover();
    });
  });

  els.historyList.querySelectorAll(".sp-history-remove").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const id = String(btn.getAttribute("data-id") || "");
      await deleteConversation(id);
    });
  });
}

async function loadSavedConversations() {
  const data = await chrome.storage.local.get([CONVERSATIONS_STORAGE_KEY]).catch(() => ({}));
  savedConversations = normalizeConversations(data?.[CONVERSATIONS_STORAGE_KEY]);
  renderHistoryList();
}

function normalizeConversations(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const messages = Array.isArray(item?.messages)
        ? item.messages
            .filter((msg) => msg && (msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string")
            .map((msg) => ({ role: msg.role, content: String(msg.content) }))
        : [];
      const id = String(item?.id || "").trim();
      if (!id || !messages.length) {
        return null;
      }
      const contextTitle = String(item?.contextTitle || "").trim();
      const contextRef = normalizeConversationContextRef(item?.contextRef || item?.contextSnapshot || item);
      const contextUrl = String(item?.contextUrl || "").trim();
      return {
        id,
        title: normalizeConversationTitle(item?.title, contextTitle, contextRef, contextUrl),
        contextKey: resolveConversationStorageKey(item?.contextKey, contextRef, contextUrl),
        contextTitle,
        contextUrl,
        isArticleContext: item?.isArticleContext !== false,
        createdAt: Number(item?.createdAt) || Date.now(),
        updatedAt: Number(item?.updatedAt) || Date.now(),
        contextRef,
        messages
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_SAVED_CONVERSATIONS);
}

function resolveConversationStorageKey(rawKey, contextRef, contextUrl = "") {
  const normalizedRefKey = buildContextKey(contextRef);
  if (normalizedRefKey) {
    return normalizedRefKey;
  }
  const normalizedUrlKey = buildContextKey({ url: contextUrl });
  if (normalizedUrlKey) {
    return normalizedUrlKey;
  }
  return String(rawKey || "").trim();
}

async function saveConversations() {
  savedConversations = normalizeConversations(savedConversations);
  await chrome.storage.local.set({
    [CONVERSATIONS_STORAGE_KEY]: savedConversations.slice(0, MAX_SAVED_CONVERSATIONS)
  });
  renderHistoryList();
}

async function restoreLatestConversationForCurrentContext() {
  const targetContextKey = liveContextKey || currentContextKey;
  const currentRef = liveContextData || contextData;
  const latest = savedConversations.find((item) => doesConversationMatchCurrentContext(item, currentRef, targetContextKey));
  if (!latest) {
    currentConversationId = "";
    currentConversationMeta = null;
    chatHistory = [];
    return false;
  }
  applyConversation(latest);
  return true;
}

function doesConversationMatchCurrentContext(conversation, currentRef, targetContextKey = "") {
  if (!conversation) {
    return false;
  }
  const normalizedConversationKey = resolveConversationStorageKey(
    conversation.contextKey,
    conversation.contextRef,
    conversation.contextUrl
  );
  const normalizedTargetKey = String(targetContextKey || buildContextKey(currentRef)).trim();
  if (normalizedConversationKey && normalizedTargetKey && normalizedConversationKey === normalizedTargetKey) {
    return true;
  }

  const conversationUrl = String(conversation.contextUrl || conversation.contextRef?.url || "").trim();
  const currentUrl = String(currentRef?.url || "").trim();
  if (conversationUrl && currentUrl) {
    return doesTabMatchContextUrl(currentUrl, conversationUrl);
  }
  return false;
}

function applyConversation(conversation) {
  if (!conversation) {
    return;
  }
  currentConversationId = conversation.id;
  currentConversationMeta = {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    contextKey: conversation.contextKey,
    contextTitle: conversation.contextTitle,
    contextUrl: conversation.contextUrl,
    isArticleContext: conversation.isArticleContext !== false,
    pinnedContext: true,
    contextRef: conversation.contextRef || null,
    resolvedContext: null
  };
  chatHistory = Array.isArray(conversation.messages)
    ? conversation.messages.map((item) => ({ role: item.role, content: String(item.content || "") }))
    : [];
  if (liveContextData && conversation.contextKey && conversation.contextKey === liveContextKey) {
    contextData = { ...liveContextData };
    currentContextKey = liveContextKey;
    currentConversationMeta.resolvedContext = { ...liveContextData };
  } else if (conversation.contextRef) {
    contextData = buildContextPlaceholder(conversation.contextRef);
    currentContextKey = conversation.contextKey || buildContextKey(contextData);
  }
  updateContextChip();
  renderHistoryList();
}

function loadConversationById(id) {
  const conversation = savedConversations.find((item) => item.id === id);
  if (!conversation) {
    return;
  }
  applyConversation(conversation);
  renderInitialState();
  if (conversation.contextKey && conversation.contextKey !== liveContextKey) {
    showConversationContextNotice("正在加载原文章上下文...");
    void hydratePinnedConversationContext({ silent: true });
  }
}

async function deleteConversation(id) {
  const wasCurrent = id && id === currentConversationId;
  savedConversations = savedConversations.filter((item) => item.id !== id);
  await saveConversations();
  if (!wasCurrent) {
    return;
  }
  currentConversationId = "";
  currentConversationMeta = null;
  chatHistory = [];
  if (liveContextData) {
    contextData = { ...liveContextData };
    currentContextKey = liveContextKey || buildContextKey(liveContextData);
    updateContextChip();
  }
  renderInitialState();
}

async function clearAllConversations() {
  if (!savedConversations.length) {
    return;
  }
  if (!confirm("确定要清空全部历史对话吗？")) {
    return;
  }
  savedConversations = [];
  currentConversationId = "";
  currentConversationMeta = null;
  chatHistory = [];
  await saveConversations();
  hideHistoryPopover();
  if (liveContextData) {
    contextData = { ...liveContextData };
    currentContextKey = liveContextKey || buildContextKey(liveContextData);
    updateContextChip();
  }
  renderInitialState();
}

function insertPresetPrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text) {
    return;
  }
  const current = els.input.value.trim();
  els.input.value = current ? `${current}\n${text}` : text;
  els.input.focus();
  autosizeInput();
}

function togglePresetPopover(event) {
  event?.stopPropagation();
  hideHistoryPopover();
  const willShow = els.presetPopover.hidden;
  els.presetPopover.hidden = !willShow;
  if (willShow) {
    renderPresetPrompts();
    els.presetInput.value = "";
    els.presetInput.focus();
  }
}

function hidePresetPopover() {
  els.presetPopover.hidden = true;
}

function toggleHistoryPopover(event) {
  event?.stopPropagation();
  hidePresetPopover();
  const willShow = els.historyPopover.hidden;
  els.historyPopover.hidden = !willShow;
  if (willShow) {
    renderHistoryList();
  }
}

function hideHistoryPopover() {
  els.historyPopover.hidden = true;
}

function handleDocumentClick(event) {
  if (els.presetPopover.hidden && els.historyPopover.hidden) {
    return;
  }
  if (!(event.target instanceof Element)) {
    hidePresetPopover();
    hideHistoryPopover();
    return;
  }
  if (event.target.closest("#spPresetPopover") || event.target.closest("#spPresetBtn")) {
    return;
  }
  if (event.target.closest("#spHistoryPopover") || event.target.closest("#spHistoryBtn")) {
    return;
  }
  hidePresetPopover();
  hideHistoryPopover();
}

function scheduleLiveContextSync(forceRefresh = false) {
  liveContextSyncForceRefresh = liveContextSyncForceRefresh || forceRefresh;
  if (liveContextSyncTimer) {
    window.clearTimeout(liveContextSyncTimer);
  }
  liveContextSyncTimer = window.setTimeout(() => {
    const nextForceRefresh = liveContextSyncForceRefresh;
    liveContextSyncTimer = 0;
    liveContextSyncForceRefresh = false;
    void syncLiveContextState(nextForceRefresh);
  }, forceRefresh ? 120 : 220);
}

async function syncLiveContextState(forceRefresh = false) {
  const ok = await loadContextState({ forceRefresh, silent: true }).catch(() => false);
  if (currentConversationMeta?.pinnedContext || activePort || activeUserPrompt) {
    updateContextChip();
    return;
  }
  if (!ok || !contextData || !providers.length || !chatHistory.length) {
    renderInitialState();
    return;
  }
  renderSuggestions();
}

async function addPresetPrompt() {
  const text = String(els.presetInput.value || "").trim();
  if (!text) {
    return;
  }
  const previousPrompts = [...(aiPrefs.aiPresetPrompts || [])];
  aiPrefs.aiPresetPrompts = previousPrompts.includes(text)
    ? previousPrompts
    : [...previousPrompts, text].slice(0, 12);
  const result = await persistAiPresetPrompts();
  if (!result.ok) {
    // 保存失败必须回滚内存列表：否则界面显示"添加成功"，重开面板又从存储读回旧值
    aiPrefs.aiPresetPrompts = previousPrompts;
    presetErrorText = `保存失败：${result.error}`;
    renderPresetPrompts();
    return;
  }
  presetErrorText = "";
  els.presetInput.value = "";
  renderPresetPrompts();
}

async function removePresetPrompt(index) {
  if (index < 0) {
    return;
  }
  const previousPrompts = [...(aiPrefs.aiPresetPrompts || [])];
  aiPrefs.aiPresetPrompts = previousPrompts.filter((_, itemIndex) => itemIndex !== index);
  const result = await persistAiPresetPrompts();
  if (!result.ok) {
    aiPrefs.aiPresetPrompts = previousPrompts;
    presetErrorText = `保存失败：${result.error}`;
  } else {
    presetErrorText = "";
  }
  renderPresetPrompts();
}

async function persistAiPresetPrompts() {
  const settingsResp = await sendRuntimeMessage({ type: "get-settings" }).catch(() => ({ ok: false }));
  if (!settingsResp?.ok || !settingsResp.settings) {
    return { ok: false, error: "读取当前设置失败" };
  }
  const nextSettings = {
    ...settingsResp.settings,
    aiPresetPrompts: (aiPrefs.aiPresetPrompts || []).slice(0, 12)
  };
  const resp = await sendRuntimeMessage({ type: "save-settings", settings: nextSettings }).catch((error) => ({
    ok: false,
    error: error?.message || String(error || "保存失败")
  }));
  if (!resp?.ok) {
    return { ok: false, error: resp?.error || "保存失败" };
  }
  return { ok: true, error: "" };
}

function updateSidepanelLayoutState() {
  const useCompactInput = Boolean(
    contextData &&
    contextData.isArticleContext === false &&
    !chatHistory.length &&
    !currentConversationMeta?.pinnedContext
  );
  document.body.classList.toggle("sp-non-video-context", useCompactInput);
  if (els.input) {
    autosizeInput();
  }
}

async function refreshContextManually() {
  if (els.refreshBtn.disabled) {
    return;
  }
  setRefreshing(true);
  try {
    const ok = await loadContextState({ forceRefresh: true });
    if (ok) {
      if (!contextData || !providers.length || !chatHistory.length) {
        renderInitialState();
      } else {
        renderSuggestions();
      }
    }
  } finally {
    setRefreshing(false);
  }
}

function setRefreshing(isRefreshing) {
  els.refreshBtn.disabled = isRefreshing;
  els.refreshBtn.classList.toggle("is-loading", isRefreshing);
  if (isRefreshing) {
    els.refreshBtn.setAttribute("aria-busy", "true");
  } else {
    els.refreshBtn.removeAttribute("aria-busy");
  }
}

async function startNewConversation() {
  hidePresetPopover();
  hideHistoryPopover();
  setRefreshing(true);
  try {
    await loadContextState({ forceRefresh: true, silent: true });
  } finally {
    setRefreshing(false);
  }
  if (liveContextData) {
    contextData = { ...liveContextData };
    currentContextKey = liveContextKey || buildContextKey(liveContextData);
    updateContextChip();
  }
  restartChat({ keepContext: true });
  renderInitialState();
}

function renderConversationMessages() {
  updateSidepanelLayoutState();
  els.messages.innerHTML = "";
  suggestionsNode = null;
  if (!chatHistory.length) {
    resetConversationView("");
    return;
  }
  chatHistory.forEach((message, index) => {
    if (message.role === "user") {
      appendUserMessage(message.content, false);
      return;
    }
    const node = document.createElement("div");
    node.className = "sp-msg sp-msg-assistant";
    node.dataset.raw = String(message.content || "");
    renderAssistantMessage(node, String(message.content || ""), {
      userPrompt: findPreviousUserPrompt(index)
    });
    els.messages.appendChild(node);
  });
  shouldAutoScrollMessages = true;
  scrollToBottom(true);
}

function findPreviousUserPrompt(index) {
  for (let i = Number(index) - 1; i >= 0; i -= 1) {
    const item = chatHistory[i];
    if (item?.role === "user" && typeof item.content === "string") {
      return item.content;
    }
  }
  return "";
}

function buildConversationTitle(context) {
  const rawTitle = String(context?.title || "当前页面").trim() || "当前页面";
  return extractConversationBaseTitle(rawTitle);
}

function buildConversationContextRef(context) {
  if (!context || typeof context !== "object") {
    return null;
  }
  return {
    title: String(context.title || "").trim(),
    url: String(context.url || "").trim(),
    accountName: String(context.accountName || "").trim(),
    author: String(context.author || "").trim(),
    publishDate: String(context.publishDate || context.uploadDate || "").trim(),
    isArticleContext: context.isArticleContext !== false
  };
}

function normalizeConversationContextRef(ref) {
  return buildConversationContextRef(ref);
}

function buildContextPlaceholder(ref) {
  if (!ref || typeof ref !== "object") {
    return null;
  }
  return {
    title: String(ref.title || "").trim(),
    url: String(ref.url || "").trim(),
    accountName: String(ref.accountName || "").trim(),
    author: String(ref.author || "").trim(),
    publishDate: String(ref.publishDate || ref.uploadDate || "").trim(),
    articleMarkdown: "",
    wordCount: 0,
    isArticleContext: ref.isArticleContext !== false
  };
}

function normalizeConversationTitle(title, contextTitle = "", contextRef = null, contextUrl = "") {
  const preferredTitle = String(contextTitle || "").trim() || String(title || "").trim();
  const baseTitle = extractConversationBaseTitle(preferredTitle);
  return baseTitle || "历史对话";
}

function generateConversationId() {
  return `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function extractConversationBaseTitle(title) {
  const raw = String(title || "").trim();
  if (!raw) {
    return "当前页面";
  }
  const parts = raw
    .split(/\s+[|｜]\s+|\s+-\s+|\s+[—–]\s+|\s+[·•]\s+|\r?\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return parts[0] || raw;
}

function truncateConversationTitle(title, maxChars = 22) {
  const value = String(title || "").trim();
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

function buildConversationTitleDisplay(title, maxChars = 22) {
  const value = String(title || "").trim();
  return {
    main: value.length > maxChars ? `${value.slice(0, maxChars)}...` : value,
    suffix: ""
  };
}

function formatConversationTimestamp(value) {
  const date = new Date(Number(value) || Date.now());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

async function persistCurrentConversation() {
  if (!chatHistory.length || !contextData) {
    return;
  }
  const now = Date.now();
  if (!currentConversationId) {
    currentConversationId = generateConversationId();
    currentConversationMeta = {
      id: currentConversationId,
      title: buildConversationTitle(contextData),
      createdAt: now,
      contextKey: currentContextKey,
      contextTitle: String(contextData.title || "").trim(),
      contextUrl: String(contextData.url || "").trim(),
      isArticleContext: contextData.isArticleContext !== false,
      pinnedContext: true,
      contextRef: buildConversationContextRef(contextData),
      resolvedContext: { ...contextData }
    };
  }
  const nextConversation = {
    id: currentConversationId,
    title: currentConversationMeta?.title || buildConversationTitle(contextData),
    contextKey: String(currentConversationMeta?.contextKey || currentContextKey || "").trim(),
    contextTitle: String(currentConversationMeta?.contextTitle || contextData.title || "").trim(),
    contextUrl: String(currentConversationMeta?.contextUrl || contextData.url || "").trim(),
    isArticleContext: currentConversationMeta?.isArticleContext !== false,
    createdAt: Number(currentConversationMeta?.createdAt) || now,
    updatedAt: now,
    contextRef: currentConversationMeta?.contextRef || buildConversationContextRef(contextData),
    messages: chatHistory.map((item) => ({ role: item.role, content: String(item.content || "") }))
  };
  savedConversations = [
    nextConversation,
    ...savedConversations.filter((item) => item.id !== currentConversationId)
  ];
  currentConversationMeta = {
    id: nextConversation.id,
    title: nextConversation.title,
    createdAt: nextConversation.createdAt,
    updatedAt: nextConversation.updatedAt,
    contextKey: nextConversation.contextKey,
    contextTitle: nextConversation.contextTitle,
    contextUrl: nextConversation.contextUrl,
    isArticleContext: nextConversation.isArticleContext,
    pinnedContext: true,
    contextRef: nextConversation.contextRef,
    resolvedContext: currentConversationMeta?.resolvedContext ? { ...currentConversationMeta.resolvedContext } : { ...contextData }
  };
  await saveConversations();
}

async function ensureCurrentContextForSend() {
  if (currentConversationMeta?.pinnedContext) {
    await loadContextState({ forceRefresh: false, silent: true }).catch(() => null);
    return hydratePinnedConversationContext();
  }
  const ok = await loadContextState({ forceRefresh: false, silent: true });
  if (!ok || !contextData) {
    resetConversationView("当前页面上下文读取失败。");
    return false;
  }
  return true;
}

async function hydratePinnedConversationContext({ silent = false } = {}) {
  const targetKey = String(currentConversationMeta?.contextKey || "").trim();
  const cachedResolvedContext = currentConversationMeta?.resolvedContext;
  if (cachedResolvedContext && typeof cachedResolvedContext === "object") {
    contextData = { ...cachedResolvedContext };
    currentContextKey = targetKey || buildContextKey(contextData);
    updateContextChip();
    removeConversationContextNotice();
    return true;
  }

  if (targetKey && liveContextKey && targetKey === liveContextKey) {
    const ok = await loadContextState({ forceRefresh: false, silent: true });
    if (ok && contextData) {
      currentContextKey = targetKey;
      currentConversationMeta = {
        ...currentConversationMeta,
        resolvedContext: { ...contextData }
      };
      updateContextChip();
      removeConversationContextNotice();
      return true;
    }
  }

  const contextRef = currentConversationMeta?.contextRef || null;
  if (!contextRef) {
    removeConversationContextNotice();
    if (!silent) {
      showConversationContextError("历史对话缺少原文章信息，无法继续。");
    }
    return false;
  }

  const response = await resolveConversationContext(contextRef).catch((error) => ({
    ok: false,
    error: error?.message || String(error || "")
  }));
  if (!response?.ok || !response.payload) {
    removeConversationContextNotice();
    if (!silent) {
      showConversationContextError(`原文章上下文获取失败：${response?.error || "未知错误"}`);
    }
    return false;
  }

  contextData = response.payload;
  currentContextKey = targetKey || buildContextKey(contextData);
  currentConversationMeta = {
    ...currentConversationMeta,
    contextKey: currentContextKey,
    contextTitle: String(contextData.title || currentConversationMeta?.contextTitle || "").trim(),
    contextUrl: String(contextData.url || currentConversationMeta?.contextUrl || "").trim(),
    contextRef: buildConversationContextRef(contextData),
    resolvedContext: { ...contextData }
  };
  updateContextChip();
  removeConversationContextNotice();
  return true;
}

async function resolveConversationContext(contextRef) {
  const tab = await getActiveTab().catch(() => null);
  return sendRuntimeMessage({
    type: "ai-sidepanel-resolve-context",
    tabId: Number(tab?.id || 0) || 0,
    contextRef
  });
}

async function sendMessage() {
  const text = els.input.value.trim();
  if (!text || activePort) {
    return;
  }
  hidePresetPopover();
  hideHistoryPopover();

  const providerId = els.modelSelect.value;
  if (!providerId) {
    resetConversationView("请先在设置页配置并启用一个 AI 平台。");
    return;
  }

  const hasContext = await ensureCurrentContextForSend();
  if (!hasContext) {
    return;
  }
  if (!currentConversationMeta?.pinnedContext && currentConversationMeta?.contextKey && currentConversationMeta.contextKey !== currentContextKey) {
    currentConversationId = "";
    currentConversationMeta = null;
  }

  if (activePort) {
    try {
      activePort.disconnect();
    } catch {}
    activePort = null;
  }

  suggestionsNode?.remove();
  suggestionsNode = null;
  removeCenteredState();

  appendUserMessage(text);
  els.input.value = "";
  autosizeInput();
  setStreamingUiState(true);
  activeUserPrompt = text;
  activeAssistantNode = appendAssistantPlaceholder();
  startStreamSlowNoticeTimer();
  streamFirstTokenReceived = false;

  activePort = chrome.runtime.connect({ name: "sidepanel-chat" });
  activePort.onMessage.addListener((msg) => {
    if (!msg) {
      return;
    }
    if (msg.type === "token") {
      handleFirstStreamToken();
      appendToken(activeAssistantNode, msg.data);
    } else if (msg.type === "done") {
      finalizeAssistant(activeAssistantNode);
    } else if (msg.type === "stopped") {
      handleAssistantStopped(activeAssistantNode, msg.reason || "已停止生成");
    } else if (msg.type === "error") {
      showAssistantError(activeAssistantNode, msg.error || "未知错误");
    }
  });
  activePort.onDisconnect.addListener(() => {
    clearStreamRuntimeState();
    setStreamingUiState(false);
    activePort = null;
  });

  activePort.postMessage({
    action: "chat",
    providerId,
    context: {
      ...contextData,
      aiSystemPrompt: aiPrefs.aiSystemPrompt
    },
    prompt: text,
    history: chatHistory
  });
}

function appendUserMessage(text, shouldScroll = true) {
  const node = document.createElement("div");
  node.className = "sp-msg sp-msg-user";
  node.textContent = text;
  els.messages.appendChild(node);
  if (shouldScroll) {
    shouldAutoScrollMessages = true;
    scrollToBottom(true);
  }
}

function appendAssistantPlaceholder() {
  const node = document.createElement("div");
  node.className = "sp-msg sp-msg-assistant";
  node.dataset.raw = "";
  const cursor = document.createElement("span");
  cursor.className = "sp-msg-cursor";
  node.appendChild(cursor);
  els.messages.appendChild(node);
  shouldAutoScrollMessages = true;
  scrollToBottom(true);
  return node;
}

function appendToken(node, token) {
  if (!node) {
    return;
  }
  const raw = (node.dataset.raw || "") + String(token || "");
  node.dataset.raw = raw;
  node.innerHTML = renderMarkdown(raw) + '<span class="sp-msg-cursor"></span>';
  scrollToBottom();
}

function finalizeAssistant(node) {
  if (!node) {
    return;
  }
  clearStreamRuntimeState();
  const raw = node.dataset.raw || "";
  renderAssistantMessage(node, raw, { userPrompt: activeUserPrompt });
  if (activeUserPrompt && raw) {
    chatHistory.push({ role: "user", content: activeUserPrompt });
    chatHistory.push({ role: "assistant", content: raw });
    activeUserPrompt = "";
    void persistCurrentConversation();
  }
  if (activePort) {
    try {
      activePort.disconnect();
    } catch {}
    activePort = null;
  }
  setStreamingUiState(false);
  els.input.focus();
  scrollToBottom();
}

function showAssistantError(node, error) {
  if (!node) {
    return;
  }
  clearStreamRuntimeState();
  node.innerHTML = "";
  const err = document.createElement("div");
  err.className = "sp-msg-error";
  err.textContent = `错误：${error}`;
  node.appendChild(err);
  activeUserPrompt = "";
  if (activePort) {
    try {
      activePort.disconnect();
    } catch {}
    activePort = null;
  }
  setStreamingUiState(false);
  els.input.focus();
  scrollToBottom();
}

function handleAssistantStopped(node, reason) {
  if (!node) {
    return;
  }
  clearStreamRuntimeState();
  const raw = String(node.dataset.raw || "");
  if (raw.trim()) {
    renderAssistantMessage(node, raw, { userPrompt: activeUserPrompt });
    const stopped = document.createElement("div");
    stopped.className = "sp-msg-stopped";
    stopped.textContent = reason || "已停止生成";
    node.appendChild(stopped);
    if (activeUserPrompt) {
      chatHistory.push({ role: "user", content: activeUserPrompt });
      chatHistory.push({ role: "assistant", content: raw });
      activeUserPrompt = "";
      void persistCurrentConversation();
    }
  } else {
    node.innerHTML = "";
    const stopped = document.createElement("div");
    stopped.className = "sp-msg-stopped";
    stopped.textContent = reason || "已停止生成";
    node.appendChild(stopped);
    activeUserPrompt = "";
  }
  if (activePort) {
    try {
      activePort.disconnect();
    } catch {}
    activePort = null;
  }
  setStreamingUiState(false);
  els.input.focus();
  scrollToBottom();
}

function stopActiveStream() {
  if (!activePort) {
    return;
  }
  if (els.stopBtn) {
    els.stopBtn.disabled = true;
    els.stopBtn.textContent = "停止中...";
  }
  try {
    activePort.postMessage({ action: "stop" });
  } catch {
    try {
      activePort.disconnect();
    } catch {}
  }
}

function startStreamSlowNoticeTimer() {
  clearStreamRuntimeState();
  streamFirstTokenReceived = false;
  streamSlowNoticeTimer = window.setTimeout(() => {
    if (!activePort || streamFirstTokenReceived) {
      return;
    }
    showConversationContextNotice("模型响应较慢，仍在等待服务器返回...", 0);
  }, STREAM_SLOW_NOTICE_MS);
}

function handleFirstStreamToken() {
  if (streamFirstTokenReceived) {
    return;
  }
  streamFirstTokenReceived = true;
  clearStreamRuntimeState();
}

function clearStreamRuntimeState() {
  if (streamSlowNoticeTimer) {
    window.clearTimeout(streamSlowNoticeTimer);
    streamSlowNoticeTimer = 0;
  }
  streamFirstTokenReceived = false;
  removeConversationContextNotice();
}

function renderAssistantMessage(node, raw, { userPrompt = "" } = {}) {
  if (!node) {
    return;
  }
  node.innerHTML = "";
  const cleanedRaw = stripThinkBlocks(raw);
  const pasteReadyRaw = normalizeMarkdownForSectionPaste(cleanedRaw);

  const content = document.createElement("div");
  content.className = "sp-msg-assistant-body";
  content.innerHTML = renderMarkdown(cleanedRaw);
  node.appendChild(content);

  const actions = document.createElement("div");
  actions.className = "sp-msg-actions";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "sp-msg-copy-btn";
  copyBtn.setAttribute("aria-label", "复制回复");
  copyBtn.setAttribute("title", "复制回复");
  copyBtn.innerHTML = `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <rect x="9" y="9" width="10" height="10" rx="2"></rect>
      <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1"></path>
    </svg>
  `;
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pasteReadyRaw);
      copyBtn.disabled = true;
      window.setTimeout(() => {
        copyBtn.disabled = false;
      }, 500);
    } catch {
      copyBtn.disabled = true;
      window.setTimeout(() => {
        copyBtn.disabled = false;
      }, 500);
    }
  });
  actions.appendChild(copyBtn);
  node.appendChild(actions);
}

function normalizeMarkdownForSectionPaste(raw, baseLevel = 2) {
  const shift = Math.max(0, Number(baseLevel) || 0);
  const lines = String(raw || "").split("\n");
  const normalized = [];
  let inFence = false;

  lines.forEach((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      normalized.push(line);
      return;
    }

    if (inFence) {
      normalized.push(line);
      return;
    }

    const headingMatch = line.match(/^(\s*)(#{1,3})(\s+.*)$/);
    if (!headingMatch) {
      normalized.push(line);
      return;
    }

    const [, indent, hashes, suffix] = headingMatch;
    normalized.push(`${indent}${"#".repeat(hashes.length + shift)}${suffix}`);
  });

  return normalized.join("\n");
}

function doesTabMatchContextUrl(tabUrl, targetUrl) {
  const normalize = (value) => {
    try {
      const parsed = new URL(String(value || "").trim());
      parsed.hash = "";
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return String(value || "").trim();
    }
  };
  const current = normalize(tabUrl);
  const target = normalize(targetUrl);
  if (!current || !target) {
    return false;
  }
  return current === target;
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") {
      return true;
    }
    await delay(250);
  }
  throw new Error("页面加载超时");
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function restartChat({ keepContext = false } = {}) {
  clearStreamRuntimeState();
  if (activePort) {
    try {
      activePort.disconnect();
    } catch {}
    activePort = null;
  }

  activeAssistantNode = null;
  activeUserPrompt = "";
  chatHistory = [];
  currentConversationId = "";
  currentConversationMeta = null;
  if (!keepContext) {
    currentContextKey = buildContextKey(contextData);
  }
  updateContextChip();
  resetConversationView("");
  setStreamingUiState(false);
  els.input.value = "";
  autosizeInput();
}

function removeCenteredState() {
  els.messages.querySelectorAll(".sp-center-error").forEach((node) => node.remove());
}

function showConversationContextError(message) {
  if (!String(message || "").trim()) {
    return;
  }
  removeConversationContextNotice();
  removeCenteredState();
  const stateNode = document.createElement("div");
  stateNode.className = "sp-center-error";
  stateNode.textContent = String(message);
  els.messages.appendChild(stateNode);
  scrollToBottom();
}

function showConversationContextNotice(message, autoHideMs = 0) {
  removeConversationContextNotice();
  const notice = document.createElement("div");
  notice.className = "sp-context-notice";
  notice.textContent = String(message || "").trim();
  els.messages.prepend(notice);
  if (autoHideMs > 0) {
    contextNoticeTimer = window.setTimeout(() => {
      removeConversationContextNotice();
    }, autoHideMs);
  }
}

function removeConversationContextNotice() {
  if (contextNoticeTimer) {
    window.clearTimeout(contextNoticeTimer);
    contextNoticeTimer = 0;
  }
  els.messages.querySelectorAll(".sp-context-notice").forEach((node) => node.remove());
}

function isMessagesNearBottom(threshold = 56) {
  const { scrollTop, scrollHeight, clientHeight } = els.messages;
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

function renderMarkdown(text) {
  let escaped = escapeHtml(stripThinkBlocks(text));
  const codeBlocks = [];
  escaped = escaped.replace(/```([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
    return `\u0001BOC_CODE_${codeBlocks.length - 1}\u0001`;
  });

  const lines = escaped.split("\n");
  const out = [];
  let listType = "";
  let listStartNumber = 1;
  let paraBuf = [];

  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${renderInline(paraBuf.join(" "))}</p>`);
      paraBuf = [];
    }
  };
  const closeList = () => {
    if (!listType) {
      return;
    }
    out.push(listType === "ul" ? "</ul>" : "</ol>");
    listType = "";
    listStartNumber = 1;
  };
  const openList = (nextType, startNumber = 1) => {
    if (listType === nextType && (nextType !== "ol" || listStartNumber === startNumber)) {
      return;
    }
    closeList();
    listType = nextType;
    listStartNumber = nextType === "ol" ? startNumber : 1;
    if (nextType === "ul") {
      out.push("<ul>");
      return;
    }
    out.push(startNumber > 1 ? `<ol start="${startNumber}">` : "<ol>");
  };
  const getNextListType = (startIndex) => {
    for (let index = startIndex; index < lines.length; index += 1) {
      const nextLine = lines[index].trim();
      if (!nextLine) {
        continue;
      }
      if (/^[-*+]\s+(.+)$/.test(nextLine)) {
        return "ul";
      }
      if (/^\d+\.\s+(.+)$/.test(nextLine)) {
        return "ol";
      }
      break;
    }
    return "";
  };
  const isTableSeparatorLine = (value) => /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(value);
  const isTableRowLine = (value) => /^\|.+\|$/.test(value);
  const splitTableCells = (value) =>
    value
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => renderInline(cell.trim()));

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    const codeMatch = line.match(/^\u0001BOC_CODE_(\d+)\u0001$/);
    if (codeMatch) {
      flushPara();
      closeList();
      out.push(`<pre><code>${codeBlocks[Number(codeMatch[1])]}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length + 2;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (
      isTableRowLine(line) &&
      index + 1 < lines.length &&
      isTableSeparatorLine(lines[index + 1].trim())
    ) {
      flushPara();
      closeList();
      const headers = splitTableCells(line);
      const bodyRows = [];
      index += 2;
      while (index < lines.length) {
        const tableLine = lines[index].trim();
        if (!isTableRowLine(tableLine)) {
          index -= 1;
          break;
        }
        bodyRows.push(splitTableCells(tableLine));
        index += 1;
      }
      out.push(
        `<table><thead><tr>${headers.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${
          bodyRows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")
        }</tbody></table>`
      );
      continue;
    }

    const ul = line.match(/^[-*+]\s+(.+)$/);
    if (ul) {
      flushPara();
      openList("ul");
      out.push(`<li>${renderInline(ul[1])}</li>`);
      continue;
    }

    const ol = line.match(/^(\d+)\.\s+(.+)$/);
    if (ol) {
      flushPara();
      const orderNumber = Number(ol[1]) || 1;
      openList("ol", orderNumber);
      out.push(`<li>${renderInline(ol[2])}</li>`);
      continue;
    }

    if (!line) {
      flushPara();
      if (listType && getNextListType(index + 1) === listType) {
        continue;
      }
      closeList();
      continue;
    }

    paraBuf.push(line);
  }

  flushPara();
  closeList();
  return out.join("");
}

function renderInline(text) {
  return text
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, (_, c) => `<strong>${c}</strong>`)
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, pre, c) => `${pre}<em>${c}</em>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
      const safeUrl = /^(https?:|mailto:|#)/i.test(u) ? u : "#";
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${t}</a>`;
    });
}

function stripThinkBlocks(text) {
  return String(text || "")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<\/think>/gi, "")
    .replace(/^\s*<\/?think\b[^>]*>\s*$/gim, "")
    .trim();
}

function scrollToBottom(force = false) {
  if (!force && !shouldAutoScrollMessages) {
    return;
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value, max) {
  const s = String(value || "");
  return s.length > max ? s.slice(0, max) + "..." : s;
}
