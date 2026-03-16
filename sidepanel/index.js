let papers = [];
let settings = { useWebVPN: false, fetchLevels: true };
let sortField = "";
let sortDir = "desc";
let searchQuery = "";
let viewMode = "all";

const selectedIds = new Set();
const downloadState = {};
const logs = [];
const levelCache = new Map();
const levelPending = new Map();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizePaper(raw) {
  const storedLink = raw.pdfLink || "";
  const storedLabel = raw.downloadLabel || "";
  const invalidStoredLink =
    /\.caj(\?|$)/i.test(storedLink) ||
    /\.(html?|mhtml?)(\?|$)/i.test(storedLink) ||
    /CAJ/i.test(storedLabel);

  return {
    id: raw.id,
    title: raw.title || "未命名文献",
    detailUrl: raw.detailUrl || "",
    date: raw.date || "",
    quote: raw.quote || "0",
    download: raw.download || "0",
    source: raw.source || "",
    sourceUrl: raw.sourceUrl || "",
    author: raw.author || "",
    pdfLink: invalidStoredLink ? "" : storedLink,
    downloadMode: invalidStoredLink ? "" : (raw.downloadMode || ""),
    downloadLabel: invalidStoredLink ? "" : storedLabel,
    keywords: raw.keywords || "",
    abstract: raw.abstract || "",
    level: normalizeLevelValue(raw.level) || "Wait",
  };
}

const LEVEL_RULES = [
  { label: "北大核心", patterns: [/北大核心/i, /中文核心/i, /核心期刊要目总览/i] },
  { label: "南大核心", patterns: [/南大核心/i, /CSSCI/i] },
  { label: "AMI", patterns: [/\bAMI\b/i, /AMI综合评价/i, /AMI核心/i, /AMI权威/i, /AMI拓展/i] },
  { label: "CSCD", patterns: [/\bCSCD\b/i] },
  { label: "科技核心", patterns: [/科技核心/i, /中国科技核心期刊/i] },
  { label: "EI", patterns: [/\bEI\b/i] },
  { label: "SCI", patterns: [/\bSCI\b/i] },
  { label: "SSCI", patterns: [/\bSSCI\b/i] },
];

const JOURNAL_NAME_LEVEL_RULES = [
  { pattern: /暨南学报.*哲学社会科学版/i, levels: ["北大核心", "南大核心"] },
  { pattern: /中国法学/i, levels: ["北大核心", "南大核心"] },
  { pattern: /法学研究/i, levels: ["北大核心", "南大核心"] },
  { pattern: /中外法学/i, levels: ["北大核心", "南大核心"] },
  { pattern: /法学家/i, levels: ["北大核心", "南大核心"] },
  { pattern: /法商研究/i, levels: ["北大核心", "南大核心"] },
  { pattern: /法学评论/i, levels: ["北大核心", "南大核心"] },
  { pattern: /现代法学/i, levels: ["北大核心", "南大核心"] },
];

function extractLevelTokens(text) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  return LEVEL_RULES
    .filter((rule) => rule.patterns.some((pattern) => pattern.test(source)))
    .map((rule) => rule.label);
}

function normalizeLevelValue(value) {
  const tokens = extractLevelTokens(value);
  return tokens.length > 0 ? tokens.join("/") : "";
}

function inferLevelFromJournalName(source) {
  const text = String(source || "").trim();
  if (!text) return "";
  const matched = JOURNAL_NAME_LEVEL_RULES.find((rule) => rule.pattern.test(text));
  return matched ? matched.levels.join("/") : "";
}

function hasCanonicalLevel(level) {
  return Boolean(normalizeLevelValue(level));
}

function normalizeComparableUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(value || "").trim().toLowerCase();
  }
}

function isLikelyJournalSourceUrl(value) {
  const normalized = normalizeComparableUrl(value);
  if (!normalized) return false;
  return /journal|magazine|detail|brief|catalog/i.test(normalized);
}

function isUsableDownloadLink(paper) {
  const link = String(paper?.pdfLink || "").trim();
  if (!link || /^javascript:/i.test(link)) return false;
  if (/\.caj(\?|$)/i.test(link) || /\.(html?|mhtml?)(\?|$)/i.test(link)) return false;
  if (paper?.detailUrl && normalizeComparableUrl(link) === normalizeComparableUrl(paper.detailUrl)) return false;
  return true;
}

function isPaperDownloadable(paper) {
  return Boolean(
    paper?.downloadMode === "pdf-click" ||
    paper?.downloadMode === "pdf-link" ||
    isUsableDownloadLink(paper)
  );
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToContent(message) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("无活动标签页");
  return chrome.tabs.sendMessage(tab.id, message);
}

async function sendToBackground(message) {
  return chrome.runtime.sendMessage(message);
}

async function ensureContentScript() {
  const tab = await getActiveTab();
  if (!tab?.id) return false;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "PING" });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/main.js"],
      });
      return true;
    } catch {
      return false;
    }
  }
}

async function fetchDetailSnapshot(url) {
  const toAbsolute = (value, base) => {
    try {
      return new URL(value, base).href;
    } catch {
      return value || "";
    }
  };

  const normalizeText = (value) => (value || "").replace(/\s+/g, " ").trim();
  const levelRules = [
    { label: "北大核心", patterns: [/北大核心/i, /中文核心/i, /核心期刊要目总览/i] },
    { label: "南大核心", patterns: [/南大核心/i, /CSSCI/i] },
    { label: "AMI", patterns: [/\bAMI\b/i, /AMI综合评价/i, /AMI核心/i, /AMI权威/i, /AMI拓展/i] },
    { label: "CSCD", patterns: [/\bCSCD\b/i] },
    { label: "科技核心", patterns: [/科技核心/i, /中国科技核心期刊/i] },
    { label: "EI", patterns: [/\bEI\b/i] },
    { label: "SCI", patterns: [/\bSCI\b/i] },
    { label: "SSCI", patterns: [/\bSSCI\b/i] },
  ];
  const localExtractLevelTokens = (text) => {
    const source = String(text || "").replace(/\s+/g, " ").trim();
    return levelRules
      .filter((rule) => rule.patterns.some((pattern) => pattern.test(source)))
      .map((rule) => rule.label);
  };

  try {
    const response = await sendToBackground({ type: "FETCH_TEXT", url, referrer: url });
    if (!response?.text) {
      return { ok: false, error: response?.error || "empty_response", pageType: "error" };
    }

    const doc = new DOMParser().parseFromString(response.text, "text/html");
    const pageTitle = normalizeText(doc.title);
    const bodyText = normalizeText(doc.body?.innerText || "");
    const headText = `${pageTitle} ${bodyText.slice(0, 200)}`;

    let pageType = "detail";
    if (/安全验证/.test(headText)) pageType = "verify";
    if (/账号登录|短信登录|用户登录|登录中国知网/.test(headText)) pageType = "login";

    const titleNode = doc.querySelector(".wx-tit h1, .brief h1, .title h1, h1");
    if (titleNode) titleNode.querySelectorAll("span").forEach((node) => node.remove());

    const sourceContainers = Array.from(
      doc.querySelectorAll(".source, .orgn, .wxBaseinfo, .brief, .info, .top-tip")
    );
    const pickSourceAnchor = () => {
      const direct = Array.from(doc.querySelectorAll(".source a, .orgn a")).find((node) => {
        const href = node.getAttribute("href") || "";
        const text = normalizeText(node.textContent);
        return Boolean(text) && !/^javascript:/i.test(href);
      });
      if (direct) return direct;

      const labeledContainer = sourceContainers.find((container) => /来源|期刊|辑刊/.test(normalizeText(container.textContent)));
      if (labeledContainer) {
        const labeledAnchor = Array.from(labeledContainer.querySelectorAll("a")).find((node) => {
          const href = node.getAttribute("href") || "";
          const text = normalizeText(node.textContent);
          return Boolean(text) && !/作者|基金|分类号|摘要/.test(text) && !/^javascript:/i.test(href);
        });
        if (labeledAnchor) return labeledAnchor;
      }

      return Array.from(
        doc.querySelectorAll(".wxBaseinfo a, .top-tip a, .brief a, .info a")
      ).find((node) => {
        const href = node.getAttribute("href") || "";
        const text = normalizeText(node.textContent);
        const containerText = normalizeText(node.parentElement?.textContent || node.closest("li, p, div, span")?.textContent || "");
        return Boolean(text) &&
          !/作者|基金|分类号|摘要/.test(text) &&
          /来源|期刊|辑刊/.test(containerText) &&
          !/^javascript:/i.test(href);
      }) || null;
    };

    const author = Array.from(doc.querySelectorAll(".author a, .author span, .author"))
      .map((node) => normalizeText(node.textContent).replace(/;$/g, ""))
      .filter(Boolean)
      .filter((item, index, arr) => arr.indexOf(item) === index)
      .join("; ");

    const keywords = Array.from(doc.querySelectorAll(".keywords a, .kw_main a, .keyword a"))
      .map((node) => normalizeText(node.textContent).replace(/;$/g, ""))
      .filter(Boolean)
      .filter((item, index, arr) => arr.indexOf(item) === index)
      .join(",");

    const abstractNode = doc.querySelector("#ChDivSummary, .abstract-text, .summary, .abstract");
    const sourceAnchor = pickSourceAnchor();

    const downloadCandidates = Array.from(doc.querySelectorAll(".operate-btn a, a")).map((node) => ({
      node,
      text: normalizeText(node.textContent).replace(/\s+/g, ""),
      href: node.getAttribute("href") || "",
    }));
    const pdfAnchor = downloadCandidates.find((item) => /PDF下载/.test(item.text));
    const wholeBookAnchor = downloadCandidates.find((item) => /整本下载/.test(item.text));
    const cajAnchor = downloadCandidates.find((item) => /CAJ下载/.test(item.text));
    const preferredAnchor = pdfAnchor || wholeBookAnchor || null;
    const preferredHref = preferredAnchor?.href && !/^javascript:/i.test(preferredAnchor.href)
      ? toAbsolute(preferredAnchor.href, response.finalUrl || url)
      : "";

    const levelCandidates = Array.from(
      doc.querySelectorAll(".top-tip span, .doc-type span, .wxBaseinfo span, .brief span, .tag")
    )
      .map((node) => normalizeText(node.textContent))
      .filter(Boolean);
    const levelSet = new Set([
      ...levelCandidates.flatMap((item) => localExtractLevelTokens(item)),
      ...localExtractLevelTokens(bodyText),
    ]);

    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.finalUrl || url,
      pageType,
      title: normalizeText(titleNode?.textContent || ""),
      author,
      keywords,
      abstract: normalizeText(abstractNode?.textContent || ""),
      source: normalizeText(sourceAnchor?.textContent || ""),
      sourceUrl: sourceAnchor ? toAbsolute(sourceAnchor.getAttribute("href"), response.finalUrl || url) : "",
      pdfLink: preferredHref,
      downloadAvailable: Boolean(preferredAnchor),
      downloadMode: preferredAnchor ? (preferredHref ? "pdf-link" : "pdf-click") : (cajAnchor ? "caj-only" : ""),
      downloadLabel: preferredAnchor?.text || (cajAnchor?.text || ""),
      cajOnly: Boolean(!preferredAnchor && cajAnchor),
      level: Array.from(levelSet).join("/"),
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error), pageType: "error" };
  }
}

async function fetchJournalSnapshot(url) {
  const normalizeText = (value) => (value || "").replace(/\s+/g, " ").trim();

  try {
    const response = await sendToBackground({ type: "FETCH_TEXT", url });
    if (!response?.text) {
      return { ok: false, error: response?.error || "empty_response", pageType: "error" };
    }

    const doc = new DOMParser().parseFromString(response.text, "text/html");
    const fullText = normalizeText(doc.body?.innerText || "");
    const headText = `${normalizeText(doc.title)} ${fullText.slice(0, 240)}`;

    let pageType = "journal";
    if (/安全验证/.test(headText)) pageType = "verify";
    if (/账号登录|短信登录|用户登录|登录中国知网/.test(headText)) pageType = "login";

    const parts = Array.from(doc.querySelectorAll(".journalType.journalType2 span, .journalType span, .detailDocu span"))
      .map((node) => normalizeText(node.textContent))
      .filter(Boolean)
      .filter((item, index, arr) => arr.indexOf(item) === index);

    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.finalUrl || url,
      pageType,
      rawLevel: parts.join("/"),
      level: normalizeLevelValue(parts.join(" ")) || normalizeLevelValue(fullText),
      text: fullText.slice(0, 4000),
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error), pageType: "error" };
  }
}

async function loadSettings() {
  const data = await chrome.storage.local.get([
    "useWebVPN",
    "fetchLevels",
    "cnkiPapers",
    "cnkiSort",
  ]);

  settings.useWebVPN = data.useWebVPN ?? false;
  settings.fetchLevels = data.fetchLevels ?? true;
  papers = Array.isArray(data.cnkiPapers) ? data.cnkiPapers.map(normalizePaper) : [];

  if (data.cnkiSort) {
    sortField = data.cnkiSort.field || "";
    sortDir = data.cnkiSort.dir || "desc";
  }
}

async function savePapers() {
  await chrome.storage.local.set({ cnkiPapers: papers });
}

async function saveSort() {
  await chrome.storage.local.set({ cnkiSort: { field: sortField, dir: sortDir } });
}

function addLog(level, title, detail = "") {
  const simplifyLogDetail = (value) => {
    return String(value || "")
      .split("\n")
      .map((line) => line
        .replace(/((https?|file):\/\/\S+)/gi, "")
        .replace(/详情页:|下载链接:|最终地址:/g, "")
        .replace(/\s+/g, " ")
        .trim())
      .filter(Boolean)
      .filter((line) => !/^"*$/.test(line))
      .slice(0, 1)
      .join("");
  };

  const entry = {
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    level,
    title,
    detail: simplifyLogDetail(detail),
  };

  logs.push(entry);
  if (level === "error") {
    $("#log-panel").hidden = false;
    $("#log-toggle").setAttribute("aria-expanded", "true");
    renderLogs();
  }
}

function renderLogs() {
  const errorLogs = logs.filter((entry) => entry.level === "error");
  $("#log-badge").hidden = errorLogs.length === 0;
  $("#log-badge").textContent = String(errorLogs.length);

  const list = $("#log-list");
  if (errorLogs.length === 0) {
    list.innerHTML = `<div class="log-empty-state"><strong>暂无错误</strong><span>抓链、下载或解析失败时会在这里显示。</span></div>`;
    return;
  }

  list.innerHTML = errorLogs.map((entry) => `
    <article class="log-entry">
      <div class="log-entry-head">
        <span>${escapeHtml(entry.title)}</span>
        <small>${escapeHtml(entry.time)}</small>
      </div>
      ${entry.detail ? `<div class="log-detail">${escapeHtml(entry.detail)}</div>` : ""}
    </article>
  `).join("");
}

function createSafeFilename(title, maxLength = 120) {
  const base = String(title || "cnki-paper")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

  return `${base || "cnki-paper"}.pdf`;
}

function isInvalidStoredDownload(paper) {
  return (
    !paper ||
    /CAJ/i.test(paper.downloadLabel || "") ||
    /\.caj(\?|$)/i.test(paper.pdfLink || "") ||
    /\.(html?|mhtml?)(\?|$)/i.test(paper.pdfLink || "")
  );
}

function getDownloadItemName(downloadItem) {
  return downloadItem?.filename || downloadItem?.finalUrl || downloadItem?.url || "";
}

function isHtmlDownloadItem(downloadItem) {
  const name = getDownloadItemName(downloadItem);
  const mime = String(downloadItem?.mime || "");
  return /\.(html?|mhtml?)(\?|$)/i.test(name) || /text\/html|application\/xhtml\+xml/i.test(mime);
}

function isCajDownloadItem(downloadItem) {
  const name = getDownloadItemName(downloadItem);
  const mime = String(downloadItem?.mime || "");
  return /\.caj(\?|$)/i.test(name) || /caj/i.test(mime);
}

function isPdfDownloadItem(downloadItem) {
  const name = getDownloadItemName(downloadItem);
  const mime = String(downloadItem?.mime || "");
  return /\.pdf(\?|$)/i.test(name) || /application\/pdf/i.test(mime);
}

function setStatus(text) {
  $("#toolbar-status").textContent = text;
}

function setProgress(percent, text) {
  $("#progress-wrap").hidden = false;
  $("#progress-fill").style.width = `${percent}%`;
  $("#progress-text").textContent = text || "处理中...";
}

function hideProgress() {
  $("#progress-wrap").hidden = true;
  $("#progress-fill").style.width = "0%";
}

function getDownloadStatus(id) {
  return downloadState[id]?.status || "";
}

function getFilteredPapers() {
  const query = searchQuery.trim().toLowerCase();

  return getSortedPapers().filter((paper) => {
    if (viewMode === "ready" && !isPaperDownloadable(paper)) return false;
    if (viewMode === "pending" && isPaperDownloadable(paper)) return false;
    if (viewMode === "failed" && getDownloadStatus(paper.id) !== "error") return false;

    if (!query) return true;
    const haystack = [
      paper.title,
      paper.author,
      paper.source,
      paper.keywords,
      paper.abstract,
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function getSortedPapers() {
  if (!sortField) return [...papers];

  return [...papers].sort((a, b) => {
    let left = a[sortField] || "";
    let right = b[sortField] || "";

    if (sortField !== "date") {
      left = parseInt(left, 10) || 0;
      right = parseInt(right, 10) || 0;
    }

    if (left < right) return sortDir === "asc" ? -1 : 1;
    if (left > right) return sortDir === "asc" ? 1 : -1;
    return 0;
  });
}

function computeMetrics() {
  return {
    total: papers.length,
    pending: papers.filter((paper) => !isPaperDownloadable(paper)).length,
    ready: papers.filter((paper) => isPaperDownloadable(paper)).length,
    success: Object.values(downloadState).filter((state) => state.status === "success").length,
  };
}

function syncSelectedIds() {
  const valid = new Set(papers.filter((paper) => isPaperDownloadable(paper)).map((paper) => paper.id));
  for (const id of [...selectedIds]) {
    if (!valid.has(id)) selectedIds.delete(id);
  }
}

function updateSelectionHeader(filteredPapers) {
  const selectableVisibleIds = filteredPapers.filter((paper) => isPaperDownloadable(paper)).map((paper) => paper.id);
  const visibleSelected = selectableVisibleIds.filter((id) => selectedIds.has(id));

  $("#select-all-visible").checked =
    selectableVisibleIds.length > 0 && visibleSelected.length === selectableVisibleIds.length;

  $("#selection-count").textContent = selectedIds.size > 0 ? `已选 ${selectedIds.size}` : "未选择";
  $("#selected-pill").hidden = selectedIds.size === 0;
  $("#selected-pill").textContent = selectedIds.size > 0 ? `(${selectedIds.size})` : "";
}

function renderSummary() {
  const metrics = computeMetrics();
  $("#hero-total").textContent = String(metrics.total);
  $("#summary-pending").textContent = String(metrics.pending);
  $("#summary-ready").textContent = String(metrics.ready);
  $("#summary-success").textContent = String(metrics.success);
}

function renderFooter() {
  const metrics = computeMetrics();
  const parts = [`${metrics.total} 篇`];
  if (metrics.ready > 0) parts.push(`${metrics.ready} 可下载`);
  if (selectedIds.size > 0) parts.push(`已选 ${selectedIds.size}`);
  if (metrics.success > 0) parts.push(`已完成 ${metrics.success}`);
  $("#footer-status").textContent = parts.join("  ·  ");
}

function renderChips() {
  $$(".view-chip").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === viewMode);
  });

  $$(".sort-chip").forEach((button) => {
    button.classList.toggle("active", button.dataset.sort === sortField);
  });
}

function getLevelBadgeMeta(level) {
  const map = {
    "北大核心": { className: "level-pku", short: "PKU" },
    "南大核心": { className: "level-cssci", short: "CSSCI" },
    AMI: { className: "level-ami", short: "AMI" },
    CSCD: { className: "level-cscd", short: "CSCD" },
    "科技核心": { className: "level-tech", short: "科技" },
    EI: { className: "level-ei", short: "EI" },
    SCI: { className: "level-sci", short: "SCI" },
    SSCI: { className: "level-ssci", short: "SSCI" },
  };
  return map[level] || { className: "level-default", short: "期刊" };
}

function renderLevelIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l2.2 4.45 4.91.72-3.55 3.47.84 4.9L12 14.2l-4.4 2.34.84-4.9L4.89 8.17l4.91-.72L12 3z"></path>
    </svg>
  `;
}

function renderLevel(level) {
  if (!settings.fetchLevels || !level || level === "Wait" || level === "无") return "";
  return level
    .split("/")
    .filter(Boolean)
    .map((item) => {
      const meta = getLevelBadgeMeta(item);
      return `
        <span class="level-badge ${meta.className}" title="期刊等级：${escapeHtml(item)}">
          <span class="level-icon">${renderLevelIcon()}</span>
          <span class="level-short">${escapeHtml(meta.short)}</span>
          <span class="level-text">${escapeHtml(item)}</span>
        </span>
      `;
    })
    .join("");
}

function renderPaperCard(paper) {
  const status = getDownloadStatus(paper.id);
  const isSelected = selectedIds.has(paper.id);
  const hasAbstract = Boolean(paper.abstract);
  const keywords = paper.keywords
    ? paper.keywords.split(",").map((item) => item.trim()).filter(Boolean)
    : [];

  let stateHtml = '<span class="state-tag pending">待抓链</span>';
  if (status === "downloading") stateHtml = '<span class="state-tag downloading">下载中</span>';
  if (status === "success") stateHtml = '<span class="state-tag success">已完成</span>';
  if (status === "error") stateHtml = '<span class="state-tag error">失败</span>';
  if (!status && isPaperDownloadable(paper)) stateHtml = '<button class="action-btn dl-btn" data-id="' + paper.id + '">下载 PDF</button>';
  if (status === "error") {
    stateHtml = `
      <span class="state-tag error" title="${escapeHtml(downloadState[paper.id]?.error || "")}">失败</span>
      <button class="retry-btn" data-id="${paper.id}">重试</button>
    `;
  }

  return `
    <article class="paper-card" data-id="${paper.id}" data-status="${escapeHtml(status || (isPaperDownloadable(paper) ? "ready" : "pending"))}">
      <input class="paper-check" type="checkbox" data-id="${paper.id}" ${isPaperDownloadable(paper) ? "" : "disabled"} ${isSelected ? "checked" : ""}>
      <div class="paper-main">
        <div class="paper-header">
          <div>
            <h2 class="paper-title">${escapeHtml(paper.title)}</h2>
            <div class="paper-meta">
              ${paper.author ? `<span>${escapeHtml(paper.author)}</span><span class="dot">·</span>` : ""}
              ${paper.source ? `<span>${escapeHtml(paper.source)}</span><span class="dot">·</span>` : ""}
              <span>${escapeHtml(paper.date || "无日期")}</span>
            </div>
          </div>
        <div class="paper-actions">
          ${hasAbstract ? `
            <button class="paper-icon-btn abstract-toggle-btn" data-id="${paper.id}" title="展开摘要" aria-label="展开摘要">
              <svg viewBox="0 0 24 24"><path d="M7 6h10M7 12h10M7 18h6"></path></svg>
            </button>
          ` : ""}
          <button class="paper-icon-btn copy-info-btn" data-id="${paper.id}" title="复制文献信息" aria-label="复制文献信息">
            <svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V6a2 2 0 0 1 2-2h9"></path></svg>
          </button>
          <button class="paper-icon-btn remove-paper-btn" data-id="${paper.id}" title="移出队列" aria-label="移出队列">
            <svg viewBox="0 0 24 24"><path d="M6 7h12"></path><path d="M9 7V5h6v2"></path><path d="M8 7l1 12h6l1-12"></path></svg>
          </button>
        </div>
      </div>

        ${hasAbstract ? `<div class="paper-abstract" id="abstract-${paper.id}" hidden>${escapeHtml(paper.abstract)}</div>` : ""}

        <div class="paper-stats">
          <span>被引 <strong>${escapeHtml(paper.quote || "0")}</strong></span>
          <span>下载 <strong>${escapeHtml(paper.download || "0")}</strong></span>
          ${renderLevel(paper.level)}
        </div>

        ${keywords.length > 0 ? `<div class="tag-row">${keywords.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join("")}</div>` : ""}

        <div class="paper-footer">
          ${stateHtml}
        </div>
      </div>
    </article>
  `;
}

function renderList() {
  syncSelectedIds();
  renderSummary();
  renderChips();
  renderFooter();
  renderLogs();

  const filtered = getFilteredPapers();
  $("#result-count").textContent = `${filtered.length} 条结果`;
  updateSelectionHeader(filtered);

  const list = $("#paper-list");
  if (filtered.length === 0) {
    const hasAnyPapers = papers.length > 0;
    let hintTitle = "还没有可操作的条目";
    let hintText = "在知网检索结果页点击标题旁的 +，或直接点上方“抓取本页”把当前页加入队列。";

    if (hasAnyPapers && viewMode === "ready") {
      hintTitle = "当前还没有可下载条目";
      hintText = "先点上方“抓取链接”，或者直接点“批量下载”，插件会先自动抓链再继续下载。";
    } else if (hasAnyPapers && viewMode === "pending") {
      hintTitle = "当前筛选为待抓链";
      hintText = "这些条目还没有 PDF 地址。点击“抓取链接”后，会自动转到可下载状态。";
    } else if (hasAnyPapers && viewMode === "failed") {
      hintTitle = "当前没有失败条目";
      hintText = "如果抓链或下载失败，会在这里显示，并同步进入错误日志。";
    } else if (hasAnyPapers && searchQuery.trim()) {
      hintTitle = "没有匹配当前搜索的条目";
      hintText = "可以清空搜索词，或者切换上面的筛选状态继续查看。";
    }

    list.innerHTML = `
      <div class="empty-state">
        <strong>${escapeHtml(hintTitle)}</strong>
        <span>${escapeHtml(hintText)}</span>
      </div>
    `;
    return;
  }

  list.innerHTML = filtered.map(renderPaperCard).join("");
}

function setDownloadState(id, status, error = "") {
  downloadState[id] = { status, error };
  renderList();
}

function applyDetailSnapshotToPaper(paper, result) {
  if (!paper || !result) return;
  if (result?.title) paper.title = result.title;
  if (result?.author) paper.author = result.author;
  if (result?.keywords) paper.keywords = result.keywords;
  if (result?.abstract) paper.abstract = result.abstract;
  if (result?.source && (!paper.source || paper.source === result.source)) paper.source = result.source;
  if (result?.sourceUrl && (!paper.sourceUrl || isLikelyJournalSourceUrl(result.sourceUrl))) {
    paper.sourceUrl = result.sourceUrl;
  }
  if (result?.pdfLink) paper.pdfLink = result.pdfLink;
  if (result?.downloadMode) paper.downloadMode = result.downloadMode;
  if (result?.downloadLabel) paper.downloadLabel = result.downloadLabel;
  if (result?.level) paper.level = normalizeLevelValue(result.level) || paper.level;
}

async function refreshPaperDetail(paper) {
  const result = await fetchDetailSnapshot(paper.detailUrl);
  if (!result?.ok && !result?.pageType) {
    throw new Error(result?.error || "详情页抓取失败");
  }
  applyDetailSnapshotToPaper(paper, result);
  return result;
}

async function fetchPdfLinks() {
  const pending = papers.filter((paper) =>
    !isPaperDownloadable(paper) ||
    !paper.downloadMode ||
    paper.level === "Wait" ||
    isInvalidStoredDownload(paper)
  );
  if (pending.length === 0) {
    setStatus("所有条目都已有下载信息");
    return { attempted: 0, success: papers.filter((paper) => isPaperDownloadable(paper)).length, failed: 0 };
  }

  let done = 0;
  setProgress(0, `抓链 0/${pending.length}`);
  setStatus("正在抓取详情页信息...");

  async function fetchOne(paper) {
    try {
      const result = await refreshPaperDetail(paper);

      if (result?.pageType === "verify" || result?.pageType === "login") {
        addLog(
          "error",
          `详情页被拦截: ${paper.title}`,
          `当前返回的是${result.pageType === "verify" ? "安全验证" : "登录"}页面，请先在当前知网页签完成验证/登录后重试。\n详情页: ${paper.detailUrl}`
        );
      } else if (result?.cajOnly) {
        addLog(
          "error",
          `该条目仅识别到 CAJ 下载: ${paper.title}`,
          `详情页未识别到 PDF 下载按钮，只找到了 CAJ 下载。\n详情页: ${paper.detailUrl}`
        );
      } else if (!result?.downloadAvailable && !isPaperDownloadable(paper)) {
        addLog(
          "error",
          `详情页未识别到 PDF 下载按钮: ${paper.title}`,
          `详情页: ${paper.detailUrl}\n最终地址: ${result?.finalUrl || "未知"}`
        );
      }
    } catch (error) {
      addLog("error", `抓链失败: ${paper.title}`, `${error.message}\n详情页: ${paper.detailUrl}`);
    }

    done += 1;
    setProgress(Math.round((done / pending.length) * 100), `抓链 ${done}/${pending.length}`);
  }

  const queue = [...pending];
  const beforeReady = papers.filter((paper) => isPaperDownloadable(paper)).length;
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length > 0) {
      const paper = queue.shift();
      if (!paper) break;
      await fetchOne(paper);
      await new Promise((resolve) => window.setTimeout(resolve, 280));
    }
  });

  await Promise.all(workers);
  hideProgress();
  await savePapers();

  papers.filter((paper) => isPaperDownloadable(paper)).forEach((paper) => selectedIds.add(paper.id));
  renderList();
  const afterReady = papers.filter((paper) => isPaperDownloadable(paper)).length;
  const successCount = Math.max(0, afterReady - beforeReady);
  const failedCount = pending.length - successCount;
  setStatus(successCount > 0 ? `抓链完成，新增 ${successCount} 条可下载` : "抓链完成，但还没有拿到可下载链接");

  if (settings.fetchLevels) loadAllLevels();
  return { attempted: pending.length, success: successCount, failed: failedCount };
}

async function addCurrentPageToQueue() {
  const ready = await ensureContentScript();
  if (!ready) {
    setStatus("请在知网页面使用");
    return { ok: false, error: "not_cnki_page" };
  }

  const result = await sendToContent({
    type: "ADD_ALL_PAGE",
    useWebVPN: settings.useWebVPN,
  });

  if (!result?.ok) {
    setStatus(result?.error === "no_links" ? "当前页未识别到文献列表" : "采集失败");
    return result || { ok: false, error: "collect_failed" };
  }

  if (result.added > 0 && sortField !== "") {
    sortField = "";
    sortDir = "desc";
    await saveSort();
  }

  await loadSettings();
  renderList();
  return result;
}

function waitForDownloadResult(downloadId, timeoutMs) {
  return new Promise((resolve) => {
    const cleanup = () => {
      window.clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
    };

    const finish = (status, error = "") => {
      cleanup();
      chrome.downloads.search({ id: downloadId }, (items) => {
        resolve({ status, error, item: items?.[0] || null });
      });
    };

    const timer = window.setTimeout(() => {
      finish("timeout", "下载等待超时");
    }, timeoutMs);

    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete") {
        finish("complete");
      } else if (delta.state?.current === "interrupted") {
        finish("interrupted", delta.error?.current || "下载中断");
      }
    };

    chrome.downloads.onChanged.addListener(onChanged);

    chrome.downloads.search({ id: downloadId }, (items) => {
      const item = items?.[0];
      if (!item) return;
      if (item.state === "complete") finish("complete");
      else if (item.state === "interrupted") finish("interrupted", item.error || "下载中断");
    });
  });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("详情页加载超时"));
    }, timeoutMs);

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") {
        window.clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(true);
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function isMatchingDownloadItem(downloadItem, expectedUrl) {
  const expected = normalizeComparableUrl(expectedUrl);
  const candidates = [
    downloadItem?.url,
    downloadItem?.finalUrl,
    downloadItem?.referrer,
  ]
    .map((value) => normalizeComparableUrl(value))
    .filter(Boolean);

  if (expected && candidates.some((value) => value === expected || value.includes(expected) || expected.includes(value))) {
    return true;
  }

  return candidates.some((value) => /cnki|kns|download/i.test(value));
}

function waitForMatchingDownload(expectedUrl, timeoutMs) {
  return new Promise((resolve) => {
    let matchedId = null;

    const cleanup = () => {
      window.clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreated);
      chrome.downloads.onChanged.removeListener(onChanged);
    };

    const finish = (status, error = "") => {
      cleanup();
      if (matchedId == null) {
        resolve({ status, error, item: null });
        return;
      }

      chrome.downloads.search({ id: matchedId }, (items) => {
        resolve({ status, error, item: items?.[0] || null });
      });
    };

    const timer = window.setTimeout(() => finish("timeout", "下载等待超时"), timeoutMs);
    const onCreated = (item) => {
      if (!isMatchingDownloadItem(item, expectedUrl)) return;
      matchedId = item.id;
      if (item.state === "complete") finish("complete");
      else if (item.state === "interrupted") finish("interrupted", item.error || "下载中断");
    };
    const onChanged = (delta) => {
      if (matchedId == null || delta.id !== matchedId) return;
      if (delta.state?.current === "complete") finish("complete");
      else if (delta.state?.current === "interrupted") finish("interrupted", delta.error?.current || "下载中断");
    };

    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

async function triggerIframeDownload(url, baseUrl) {
  const tab = await chrome.tabs.create({ url: baseUrl || url, active: false });
  if (!tab?.id) throw new Error("无法创建下载标签页");

  try {
    await waitForTabComplete(tab.id, 20000);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: (targetUrl) => {
        let frame = document.getElementById("__cnki_atlas_dl_frame__");
        if (!frame) {
          frame = document.createElement("iframe");
          frame.id = "__cnki_atlas_dl_frame__";
          frame.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
          document.body.appendChild(frame);
        }
        frame.src = targetUrl;
      },
      args: [url],
    });
  } finally {
    window.setTimeout(() => {
      chrome.tabs.remove(tab.id).catch(() => {});
    }, 3000);
  }
}

async function triggerDownloadFromDetailPage(detailUrl) {
  const tab = await chrome.tabs.create({ url: detailUrl, active: false });

  try {
    if (!tab?.id) throw new Error("无法创建详情页标签");
    await waitForTabComplete(tab.id, 20000);

    const watchDownload = waitForMatchingDownload("", 12000);
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        const normalize = (value) => (value || "").replace(/\s+/g, "");
        const candidates = Array.from(document.querySelectorAll("a, button, span")).map((node) => ({
          node,
          text: normalize(node.textContent || ""),
        }));
        const pdfTarget = candidates.find((item) => /PDF下载/.test(item.text));
        const wholeBookTarget = candidates.find((item) => /整本下载/.test(item.text));
        const target = pdfTarget?.node || wholeBookTarget?.node || null;
        if (!target) {
          return {
            ok: false,
            pageTitle: document.title,
            pageText: (document.body?.innerText || "").slice(0, 500),
          };
        }

        if (target.tagName === "A") target.setAttribute("target", "_self");
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        target.click();

        return {
          ok: true,
          text: normalize(target.textContent || ""),
          href: target.getAttribute("href") || "",
          pageTitle: document.title,
        };
      },
    });

    const downloadItem = await watchDownload;
    return { ...(result?.result || {}), downloadItem };
  } finally {
    if (tab?.id) {
      window.setTimeout(() => {
        chrome.tabs.remove(tab.id).catch(() => {});
      }, 2500);
    }
  }
}

function getDownloadFailureMessage(downloadResult) {
  if (!downloadResult) return "浏览器没有创建下载任务";
  if (downloadResult.status === "timeout") return "下载等待超时，浏览器可能仍在处理";
  if (downloadResult.status === "interrupted") return downloadResult.error || "下载中断";
  if (isHtmlDownloadItem(downloadResult.item)) return "下载结果是 HTML 页面，不是真正的 PDF 文件";
  if (isCajDownloadItem(downloadResult.item)) return "下载结果是 CAJ 文件，不是真正的 PDF 文件";
  if (!isPdfDownloadItem(downloadResult.item)) return "已生成下载任务，但无法确认结果是 PDF 文件";
  return "";
}

function getSnapshotBlockingMessage(result, paper) {
  if (result?.pageType === "verify") {
    return "知网返回安全验证页，需先人工完成验证";
  }
  if (result?.pageType === "login") {
    return "知网返回登录页，需先登录后再下载";
  }
  if (result?.cajOnly && !isUsableDownloadLink(paper)) {
    return "该条目当前只提供 CAJ 下载，没有可用的 PDF 下载入口";
  }
  if (!result?.downloadAvailable && !isPaperDownloadable(paper)) {
    return "详情页暂未识别到 PDF 下载入口";
  }
  return "";
}

async function tryDownloadViaKnownLink(paper) {
  if (!isUsableDownloadLink(paper)) {
    return { ok: false, message: "当前没有可用的 PDF 直链" };
  }

  const watchDownload = waitForMatchingDownload(paper.pdfLink, 90000);
  await triggerIframeDownload(paper.pdfLink, paper.detailUrl);
  const downloadResult = await watchDownload;
  const message = getDownloadFailureMessage(downloadResult);
  return {
    ok: downloadResult?.status === "complete" && isPdfDownloadItem(downloadResult.item),
    message,
    downloadResult,
  };
}

async function tryDownloadViaDetailPage(paper) {
  const clickResult = await triggerDownloadFromDetailPage(paper.detailUrl);
  if (!clickResult?.ok) {
    const detail = clickResult?.pageTitle || clickResult?.pageText || "详情页未找到 PDF/整本下载按钮";
    return { ok: false, message: detail, clickResult };
  }

  if (!clickResult?.downloadItem?.id) {
    return {
      ok: false,
      message: "详情页按钮已点击，但浏览器没有创建下载任务",
      clickResult,
    };
  }

  const downloadResult = await waitForDownloadResult(clickResult.downloadItem.id, 90000);
  const message = getDownloadFailureMessage(downloadResult);
  return {
    ok: downloadResult?.status === "complete" && isPdfDownloadItem(downloadResult.item),
    message,
    clickResult,
    downloadResult,
  };
}

async function downloadPaper(id, index = null, total = null) {
  const paper = papers.find((item) => item.id === id);
  if (!paper || !isPaperDownloadable(paper)) return;

  setDownloadState(id, "downloading");
  setStatus(
    index != null && total != null
      ? `正在下载第 ${index + 1}/${total} 篇：${paper.title}`
      : `正在下载：${paper.title}`
  );

  try {
    const maxAttempts = 3;
    let lastMessage = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      setStatus(
        index != null && total != null
          ? `正在下载第 ${index + 1}/${total} 篇（第 ${attempt}/${maxAttempts} 次尝试）：${paper.title}`
          : `正在下载（第 ${attempt}/${maxAttempts} 次尝试）：${paper.title}`
      );

      const snapshot = await refreshPaperDetail(paper);
      await savePapers();
      renderList();

      const blockingMessage = getSnapshotBlockingMessage(snapshot, paper);
      if (blockingMessage) {
        setDownloadState(id, "error", blockingMessage);
        addLog("error", `下载被阻断: ${paper.title}`, `${blockingMessage}\n详情页: ${paper.detailUrl}`);
        return;
      }

      try {
        const directAttempt = await tryDownloadViaKnownLink(paper);
        if (directAttempt.ok) {
          setDownloadState(id, "success");
          setStatus(`已完成 PDF 下载：${paper.title}`);
          return;
        }
        if (directAttempt.message) lastMessage = directAttempt.message;
      } catch (error) {
        lastMessage = error.message || "PDF 直链下载失败";
      }

      try {
        const detailAttempt = await tryDownloadViaDetailPage(paper);
        if (detailAttempt.ok) {
          setDownloadState(id, "success");
          setStatus(`已完成 PDF 下载：${paper.title}`);
          return;
        }
        if (detailAttempt.message) lastMessage = detailAttempt.message;
      } catch (error) {
        lastMessage = error.message || "详情页点击下载失败";
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => window.setTimeout(resolve, 1200 + attempt * 800));
      }
    }

    const finalMessage = lastMessage || "连续重试后仍未拿到 PDF 下载结果";
    setDownloadState(id, "error", finalMessage);
    addLog("error", `下载失败: ${paper.title}`, `${finalMessage}\n详情页: ${paper.detailUrl}`);
  } catch (error) {
    setDownloadState(id, "error", error.message || "未知错误");
    addLog("error", `下载失败: ${paper.title}`, `${error.message}\n详情页: ${paper.detailUrl}`);
  }
}

async function downloadSelected() {
  let ids = Array.from(selectedIds).filter((id) => isPaperDownloadable(papers.find((item) => item.id === id)));

  if (ids.length === 0) {
    const readyIds = papers.filter((paper) => isPaperDownloadable(paper)).map((paper) => paper.id);
    if (readyIds.length > 0) {
      readyIds.forEach((id) => selectedIds.add(id));
      ids = readyIds;
      renderList();
      setStatus(`已自动选择 ${ids.length} 条可下载文献`);
    }
  }

  if (ids.length === 0) {
    const pendingCount = papers.filter((paper) => !isPaperDownloadable(paper)).length;
    if (pendingCount > 0) {
      setStatus(`当前还没有可下载条目，先自动抓取 ${pendingCount} 条链接...`);
      await fetchPdfLinks();
      ids = papers.filter((paper) => isPaperDownloadable(paper)).map((paper) => paper.id);
      ids.forEach((id) => selectedIds.add(id));
      renderList();

      if (ids.length === 0) {
        setStatus("自动抓链后仍没有可下载条目，请检查登录/验证状态或查看错误日志");
        return;
      }

      setStatus(`自动抓链完成，开始下载 ${ids.length} 条文献`);
    } else {
      setStatus("队列里还没有文献，请先抓取本页或点击标题旁的 +");
      return;
    }
  }

  setStatus(`开始批量下载 ${ids.length} 篇`);
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const paper = papers.find((item) => item.id === id);
    if (!paper || !isPaperDownloadable(paper)) continue;
    if (downloadState[id]?.status === "success") continue;
    await downloadPaper(id, index, ids.length);
    await new Promise((resolve) => window.setTimeout(resolve, 1800 + Math.random() * 1600));
  }

  setStatus(`批量下载流程已触发，共 ${ids.length} 篇`);
}

async function fetchLevel(url) {
  if (!url) return "无";
  if (levelCache.has(url)) return levelCache.get(url);
  if (levelPending.has(url)) return levelPending.get(url);

  const promise = (async () => {
    try {
      const result = await fetchJournalSnapshot(url);
      if (result?.pageType === "verify" || result?.pageType === "login") return "无";
      if (result?.level) return normalizeLevelValue(result.level) || "无";

      const hit = extractLevelTokens(result?.text || "");
      return hit.join("/") || "无";
    } catch {
      return "无";
    }
  })();

  levelPending.set(url, promise);
  const resolved = await promise;
  levelPending.delete(url);
  levelCache.set(url, resolved);
  return resolved;
}

async function loadAllLevels() {
  if (!settings.fetchLevels) return;
  setStatus("正在补全期刊等级...");

  for (const paper of papers) {
    if (hasCanonicalLevel(paper.level)) continue;
    const inferredLevel = inferLevelFromJournalName(paper.source);
    if (inferredLevel) {
      paper.level = inferredLevel;
      renderList();
      continue;
    }
    if (!paper.sourceUrl || !isLikelyJournalSourceUrl(paper.sourceUrl)) {
      try {
        await refreshPaperDetail(paper);
      } catch {}
    }
    if (!paper.sourceUrl) continue;
    paper.level = await fetchLevel(paper.sourceUrl);
    if (!hasCanonicalLevel(paper.level)) {
      try {
        await refreshPaperDetail(paper);
      } catch {}
      if (paper.sourceUrl) {
        paper.level = await fetchLevel(paper.sourceUrl);
      }
    }
    renderList();
  }

  await savePapers();
  setStatus("期刊等级已更新");
}

function copyPaperInfo(id, button) {
  const paper = papers.find((item) => item.id === id);
  if (!paper) return;

  const parts = [paper.title];
  if (paper.author) parts.push(paper.author);
  if (paper.source) parts.push(paper.source);
  if (paper.date) parts.push(paper.date);

  navigator.clipboard.writeText(parts.join(". ")).then(() => {
    button.classList.add("copied");
    window.setTimeout(() => button.classList.remove("copied"), 1200);
  });
}

function setHelpDialogVisible(visible) {
  const dialog = $("#help-dialog");
  const button = $("#btn-help");
  if (!dialog || !button) return;
  dialog.hidden = !visible;
  dialog.setAttribute("aria-hidden", String(!visible));
  button.setAttribute("aria-expanded", String(visible));
}

async function bindEvents() {
  $("#btn-help").addEventListener("click", () => {
    setHelpDialogVisible(true);
  });

  $("#btn-help-close").addEventListener("click", () => {
    setHelpDialogVisible(false);
  });

  $("#help-backdrop").addEventListener("click", () => {
    setHelpDialogVisible(false);
  });

  $("#btn-fetch-links").addEventListener("click", async () => {
    try {
      const result = await addCurrentPageToQueue();
      if (!result?.ok) return;
      setStatus(
        result.added > 0
          ? `已采集 ${result.added} 篇，继续抓取链接...`
          : `本页 ${result.total} 篇已在队列中，继续抓取链接...`
      );
      await fetchPdfLinks();
    } catch (error) {
      setStatus(`抓取失败: ${error.message}`);
    }
  });
  $("#btn-batch-dl").addEventListener("click", downloadSelected);

  $("#btn-clear").addEventListener("click", async () => {
    papers = [];
    selectedIds.clear();
    Object.keys(downloadState).forEach((key) => delete downloadState[key]);
    await savePapers();
    renderList();
    setStatus("队列已清空");
  });

  $("#toggle-webvpn").addEventListener("change", async (event) => {
    settings.useWebVPN = event.target.checked;
    await chrome.storage.local.set({ useWebVPN: settings.useWebVPN });
  });

  $("#toggle-levels").addEventListener("change", async (event) => {
    settings.fetchLevels = event.target.checked;
    await chrome.storage.local.set({ fetchLevels: settings.fetchLevels });
    renderList();
    if (settings.fetchLevels) loadAllLevels();
  });

  $("#search-input").addEventListener("input", (event) => {
    searchQuery = event.target.value || "";
    renderList();
  });

  $$(".view-chip").forEach((button) => {
    button.addEventListener("click", () => {
      viewMode = button.dataset.view || "all";
      renderList();
    });
  });

  $$(".sort-chip").forEach((button) => {
    button.addEventListener("click", async () => {
      const field = button.dataset.sort || "";
      if (sortField === field) {
        sortDir = sortDir === "desc" ? "asc" : "desc";
      } else {
        sortField = field;
        sortDir = field === "date" ? "asc" : "desc";
      }
      await saveSort();
      renderList();
    });
  });

  $("#select-all-visible").addEventListener("change", (event) => {
    const checked = event.target.checked;
    getFilteredPapers()
      .filter((paper) => isPaperDownloadable(paper))
      .forEach((paper) => {
        if (checked) selectedIds.add(paper.id);
        else selectedIds.delete(paper.id);
      });
    renderList();
  });

  $("#select-ready-only").addEventListener("click", () => {
    selectedIds.clear();
    papers.filter((paper) => isPaperDownloadable(paper)).forEach((paper) => selectedIds.add(paper.id));
    renderList();
  });

  $("#paper-list").addEventListener("change", (event) => {
    const checkbox = event.target.closest(".paper-check");
    if (!checkbox) return;
    const id = parseInt(checkbox.dataset.id, 10);
    if (checkbox.checked) selectedIds.add(id);
    else selectedIds.delete(id);
    renderList();
  });

  $("#paper-list").addEventListener("click", (event) => {
    const target = event.target;
    const downloadButton = target.closest(".dl-btn");
    if (downloadButton) {
      downloadPaper(parseInt(downloadButton.dataset.id, 10));
      return;
    }

    const retryButton = target.closest(".retry-btn");
    if (retryButton) {
      downloadPaper(parseInt(retryButton.dataset.id, 10));
      return;
    }

    const abstractButton = target.closest(".abstract-toggle-btn");
    if (abstractButton) {
      const id = abstractButton.dataset.id;
      const abstract = $(`#abstract-${id}`);
      if (abstract) {
        abstract.hidden = !abstract.hidden;
        abstractButton.classList.toggle("active", !abstract.hidden);
      }
      return;
    }

    const copyButton = target.closest(".copy-info-btn");
    if (copyButton) {
      copyPaperInfo(parseInt(copyButton.dataset.id, 10), copyButton);
      return;
    }

    const removeButton = target.closest(".remove-paper-btn");
    if (removeButton) {
      const id = parseInt(removeButton.dataset.id, 10);
      papers = papers.filter((paper) => paper.id !== id);
      selectedIds.delete(id);
      delete downloadState[id];
      savePapers().then(() => {
        renderList();
        setStatus("条目已移出队列");
      });
    }
  });

  $("#log-toggle").addEventListener("click", () => {
    const panel = $("#log-panel");
    const nextHidden = !panel.hidden;
    panel.hidden = nextHidden;
    $("#log-toggle").setAttribute("aria-expanded", String(!nextHidden));
  });

  $("#log-clear").addEventListener("click", () => {
    logs.length = 0;
    renderLogs();
  });

  $("#log-copy-all").addEventListener("click", () => {
    const text = logs
      .filter((entry) => entry.level === "error")
      .map((entry) => `[${entry.time}] ${entry.title}\n${entry.detail}`)
      .join("\n\n");
    navigator.clipboard.writeText(text);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#help-dialog")?.hidden) {
      setHelpDialogVisible(false);
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.cnkiPapers) return;
    papers = (changes.cnkiPapers.newValue || []).map(normalizePaper);
    syncSelectedIds();
    renderList();
  });
}

async function init() {
  await loadSettings();
  $("#toggle-webvpn").checked = settings.useWebVPN;
  $("#toggle-levels").checked = settings.fetchLevels;
  await bindEvents();

  papers.filter((paper) => isPaperDownloadable(paper)).forEach((paper) => selectedIds.add(paper.id));

  renderList();
  setStatus("准备就绪");

  if (papers.length > 0 && settings.fetchLevels) {
    window.setTimeout(() => {
      loadAllLevels();
    }, 80);
  }
}

init();
