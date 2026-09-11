// 网页文章内容抓取：提取标题、来源/公众号、作者、发布时间、正文（转 Markdown）、原文链接。
// 优先使用微信公众号专用选择器快速识别，其余平台通过通用提取（meta 标签 + 常见正文容器 + 文本长度启发式）识别。
// 供侧边栏 AI 对话作为上下文使用。

const CONTENT_SCRIPT_VERSION = chrome.runtime.getManifest().version || "";
globalThis.__WAS_CONTENT_SCRIPT_LOADED__ = CONTENT_SCRIPT_VERSION;

// 微信公众号专用选择器（快速路径）
const WECHAT_SELECTORS = {
  title: ["#activity-name", "h1.rich_media_title", 'meta[property="og:title"]'],
  accountName: ["#js_name", "a.wx_tap_link--qq", 'meta[name="author"]'],
  author: ["#js_author_name", "#js_name", 'meta[name="author"]'],
  publishTime: ["#publish_time", 'meta[property="article:published_time"]'],
  body: ["#js_content", ".rich_media_content"]
};

// 通用文章选择器：借助 meta 标签与常见文章容器识别各类网页文章
const GENERIC_META_SELECTORS = {
  title: ['meta[property="og:title"]', 'meta[name="twitter:title"]', 'meta[name="title"]'],
  author: ['meta[property="article:author"]', 'meta[name="author"]', 'meta[name="byl"]'],
  source: ['meta[property="og:site_name"]', 'meta[name="application-name"]'],
  publishTime: ['meta[property="article:published_time"]', 'meta[name="date"]', 'meta[name="publishdate"]']
};

const GENERIC_ELEMENT_SELECTORS = {
  author: ["[rel~='author']", ".author", "[class*='author']"],
  source: ["[class*='site-name']", "[class*='org_name']", "[class*='source']"],
  publishTime: ["time[datetime]", "[class*='publish-time']", "[class*='post-date']", "[class*='pubdate']", "[class*='article-date']"]
};

const GENERIC_BODY_SELECTORS = [
  "article [class*='content']",
  "[role='article'] [class*='content']",
  "[role='main'] [class*='content']",
  "main [class*='content']",
  ".article-content", ".article__content", ".article_content",
  ".post-content", ".post__content", ".post_content",
  ".content-article", ".article-body", ".post-body",
  ".rich_media_content", "#js_content",
  "article", "[role='article']", "[role='main']", "main",
  ".content", ".article", ".post"
];

// 判断"像一篇文章"所需的最少正文字符数
const MIN_ARTICLE_BODY_CHARS = 200;

function textFromSelectors(selectors) {
  for (const selector of selectors) {
    try {
      const node = document.querySelector(selector);
      if (!node) {
        continue;
      }
      if (node instanceof HTMLMetaElement) {
        const content = String(node.getAttribute("content") || "").trim();
        if (content) {
          return content;
        }
        continue;
      }
      const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
      if (text) {
        return text;
      }
    } catch {
      // 选择器异常时继续尝试下一个
    }
  }
  return "";
}

function extractTitle() {
  // 1) meta 标签优先（og:title 等通用来源）
  const meta = textFromSelectors(GENERIC_META_SELECTORS.title);
  if (meta) {
    return meta;
  }
  // 2) 正文区/页面第一个 h1
  try {
    const h1 = document.querySelector('article h1, [role="article"] h1, main h1, h1');
    if (h1) {
      const t = String(h1.textContent || "").replace(/\s+/g, " ").trim();
      if (t) {
        return t;
      }
    }
  } catch {}
  // 3) 微信公众号专用
  const wechat = textFromSelectors(WECHAT_SELECTORS.title);
  if (wechat) {
    return wechat;
  }
  // 4) 页面标题兜底
  return String(document.title || "").replace(/[-–—|｜].*$/, "").trim();
}

// 先从 meta 标签提取，再从常见元素选择器提取（适用于来源/作者/时间等元信息）
function metaOrElement(metaSelectors, elementSelectors) {
  const meta = textFromSelectors(metaSelectors);
  if (meta) {
    return meta;
  }
  for (const selector of elementSelectors) {
    try {
      const node = document.querySelector(selector);
      if (!node) {
        continue;
      }
      if (node instanceof HTMLTimeElement) {
        const datetime = String(node.getAttribute("datetime") || "").trim();
        if (datetime) {
          return datetime;
        }
      }
      const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
      // 元信息通常是短文本；过长的节点（如整个 footer）不采用
      if (text && text.length <= 40) {
        return text;
      }
    } catch {
      // 忽略异常选择器，继续尝试下一个
    }
  }
  return "";
}

function extractSourceName() {
  return (
    metaOrElement(GENERIC_META_SELECTORS.source, GENERIC_ELEMENT_SELECTORS.source) ||
    textFromSelectors(WECHAT_SELECTORS.accountName)
  );
}

function extractAuthor() {
  return (
    metaOrElement(GENERIC_META_SELECTORS.author, GENERIC_ELEMENT_SELECTORS.author) ||
    textFromSelectors(WECHAT_SELECTORS.author)
  );
}

function extractPublishDate() {
  const raw =
    metaOrElement(GENERIC_META_SELECTORS.publishTime, GENERIC_ELEMENT_SELECTORS.publishTime) ||
    textFromSelectors(WECHAT_SELECTORS.publishTime);
  if (!raw) {
    return "";
  }
  // 常见格式：2026年09月01日 08:00 / 2026-09-01 / ISO 时间 / 2026/09/01
  const cnMatch = raw.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (cnMatch) {
    return `${cnMatch[1]}-${String(cnMatch[2]).padStart(2, "0")}-${String(cnMatch[3]).padStart(2, "0")}`;
  }
  const dateMatch = raw.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (dateMatch) {
    return `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, "0")}-${String(dateMatch[3]).padStart(2, "0")}`;
  }
  return raw.trim();
}

function extractCanonicalUrl() {
  try {
    const parsed = new URL(location.href);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return location.href.split("#")[0] || "";
  }
}

// 计算节点"有意义的正文"文本长度（排除脚本/样式/导航等噪音）
function getRootTextLength(node) {
  if (!node) {
    return 0;
  }
  try {
    const clone = node.cloneNode(true);
    clone
      .querySelectorAll(
        "script, style, svg, noscript, iframe, video, audio, canvas, nav, header, aside, footer"
      )
      .forEach((n) => n.remove());
    return String(clone.textContent || "").replace(/\s+/g, " ").trim().length;
  } catch {
    return String(node.textContent || "").length;
  }
}

// 定位正文容器：微信专用选择器 → 通用正文容器（取文本最长者）→ 正文语义容器兜底
function findMainBody() {
  const candidates = [];
  const seen = new Set();
  const record = (node) => {
    if (node && node.nodeType === Node.ELEMENT_NODE && !seen.has(node)) {
      seen.add(node);
      candidates.push(node);
    }
  };

  WECHAT_SELECTORS.body.forEach((selector) => {
    try {
      document.querySelectorAll(selector).forEach(record);
    } catch {}
  });
  GENERIC_BODY_SELECTORS.forEach((selector) => {
    try {
      document.querySelectorAll(selector).forEach(record);
    } catch {}
  });

  let best = null;
  for (const node of candidates) {
    const len = getRootTextLength(node);
    if (len < 80) {
      continue;
    }
    if (!best || len > best.len) {
      best = { node, len };
    }
  }
  if (best) {
    return best.node;
  }

  // 兜底：从语义正文容器中选取文本最长的
  const containers = ["article", "[role='article']", "[role='main']", "main"]
    .map((selector) => {
      try {
        return document.querySelector(selector);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!containers.length && document.body) {
    containers.push(document.body);
  }
  best = null;
  for (const node of containers) {
    const len = getRootTextLength(node);
    if (len < 150) {
      continue;
    }
    if (!best || len > best.len) {
      best = { node, len };
    }
  }
  return best ? best.node : null;
}

function isArticlePage() {
  const title = extractTitle();
  const body = findMainBody();
  return Boolean(title && body && getRootTextLength(body) >= MIN_ARTICLE_BODY_CHARS);
}

// ===== 正文 DOM → Markdown =====

function inlineTextToMarkdown(node) {
  let result = "";
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      result += String(child.textContent || "").replace(/\s+/g, " ");
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const tag = child.tagName.toLowerCase();
    const inner = inlineTextToMarkdown(child);
    if (!inner.trim()) {
      result += tag === "br" ? "\n" : inner;
      return;
    }
    if (tag === "strong" || tag === "b") {
      result += `**${inner.trim()}**`;
    } else if (tag === "em" || tag === "i") {
      result += `*${inner.trim()}*`;
    } else if (tag === "br") {
      result += "\n";
    } else if (tag === "a" && child.getAttribute("href")) {
      result += `[${inner.trim()}](${child.getAttribute("href")})`;
    } else if (tag === "img") {
      const alt = String(child.getAttribute("alt") || "").trim();
      result += alt ? `\n\n（图片：${alt}）\n\n` : "\n\n（图片）\n\n";
    } else {
      result += inner;
    }
  });
  return result;
}

function blockToMarkdown(node, listContext) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
    return text ? `${text}\n\n` : "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const tag = node.tagName.toLowerCase();
  const ctx = listContext || { type: "", index: 0 };
  const childBlocks = () => {
    let output = "";
    node.childNodes.forEach((child) => {
      output += blockToMarkdown(child, ctx);
    });
    return output;
  };

  if (tag === "br") {
    return "\n";
  }
  if (tag === "script" || tag === "style" || tag === "svg" || tag === "noscript") {
    return "";
  }

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    const text = inlineTextToMarkdown(node).replace(/\s+/g, " ").trim();
    return text ? `${"#".repeat(Math.min(level + 1, 6))} ${text}\n\n` : "";
  }
  if (tag === "p" || tag === "section") {
    // section 常用于布局包裹，仅在没有块级子元素时按段落处理
    if (tag === "section" && node.querySelector("p, section, h1, h2, h3, h4, h5, h6, ul, ol, blockquote")) {
      return childBlocks();
    }
    const text = inlineTextToMarkdown(node).trim();
    return text ? `${text}\n\n` : "";
  }
  if (tag === "blockquote") {
    const text = childBlocks().trim();
    if (!text) {
      return "";
    }
    return `${text.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}\n\n`;
  }
  if (tag === "ul" || tag === "ol") {
    const listType = tag;
    let index = 0;
    let output = "";
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === "li") {
        index += 1;
        const itemText = inlineTextToMarkdown(child).replace(/\s+/g, " ").trim();
        if (itemText) {
          output += `${listType === "ol" ? `${index}. ` : "- "}${itemText}\n`;
        }
      }
    });
    return output ? `${output}\n` : "";
  }
  if (tag === "img") {
    const alt = String(node.getAttribute("alt") || "").trim();
    return alt ? `（图片：${alt}）\n\n` : "（图片）\n\n";
  }
  if (tag === "hr") {
    return "---\n\n";
  }
  if (tag === "iframe" || tag === "video") {
    return "";
  }
  if (tag === "a") {
    const text = inlineTextToMarkdown(node).trim();
    return text ? `${text}\n\n` : "";
  }
  return childBlocks();
}

function extractArticleMarkdown() {
  const bodyNode = findMainBody();
  if (!bodyNode) {
    return "";
  }

  const clone = bodyNode.cloneNode(true);
  // 移除隐藏元素（部分站点正文里常有 visibility:hidden 的占位节点）
  clone.querySelectorAll("*").forEach((node) => {
    const style = window.getComputedStyle && node instanceof Element ? window.getComputedStyle(node) : null;
    if (style && (style.display === "none" || style.visibility === "hidden")) {
      node.remove();
    }
  });
  // 移除导航/页脚/评论等与正文无关的元素（对通用提取尤为重要）
  clone
    .querySelectorAll("nav, header, aside, footer, .comment, .comments, script, style, svg, noscript, iframe, video")
    .forEach((node) => node.remove());

  const markdown = blockToMarkdown(clone, null)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return markdown;
}

function buildArticlePayload() {
  const title = extractTitle();
  const articleMarkdown = extractArticleMarkdown();
  return {
    title,
    url: extractCanonicalUrl(),
    accountName: extractSourceName(),
    author: extractAuthor(),
    publishDate: extractPublishDate(),
    articleMarkdown,
    wordCount: articleMarkdown ? articleMarkdown.length : 0,
    isArticleContext: true
  };
}

// ===== 消息处理 =====

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "content-script-version") {
    sendResponse({ ok: true, version: CONTENT_SCRIPT_VERSION });
    return false;
  }

  if (message.type === "sidepanel-get-context") {
    try {
      if (!isArticlePage()) {
        sendResponse({ ok: false, error: "当前页面不是可识别的文章页" });
        return false;
      }
      sendResponse({ ok: true, payload: buildArticlePayload() });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error || "文章内容提取失败") });
    }
    return false;
  }

  return false;
});
