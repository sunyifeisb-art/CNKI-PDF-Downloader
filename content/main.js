(function () {
  if (window.__cnkiAtlasLoaded) return;
  window.__cnkiAtlasLoaded = true;

  const TITLE_SELECTORS = [
    "table.result-table-list .name a.fz14",
    ".result-table-list .fz14",
    "#gridTable .fz14",
    "table.result-table-list .name a",
    "table.result-table-list td.name a",
    '.result-table-list a[href*="/kcms"]',
    '.result-table-list a[href*="detail"]',
    ".fz14",
  ];

  const styleTag = document.createElement("style");
  styleTag.textContent = `
    .cnki-atlas-trigger {
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      margin-left: 6px;
      border: 1px solid rgba(109, 58, 45, 0.25);
      border-radius: 999px;
      background: linear-gradient(180deg, rgba(254, 250, 242, 0.98), rgba(247, 235, 218, 0.98)) !important;
      color: #7b4335;
      box-shadow: 0 3px 10px rgba(65, 45, 31, 0.08);
      font: 600 13px/1 "SF Pro Text", "PingFang SC", system-ui, sans-serif;
      cursor: pointer;
      transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease, color 160ms ease, background 160ms ease;
      vertical-align: middle;
      flex-shrink: 0;
      position: relative;
      z-index: 12;
    }

    .cnki-atlas-trigger:hover {
      transform: translateY(-1px);
      border-color: rgba(139, 58, 40, 0.45);
      color: #8f3522;
      box-shadow: 0 8px 18px rgba(84, 49, 35, 0.14);
    }

    .cnki-atlas-trigger.collected {
      border-color: rgba(140, 46, 28, 0.85);
      background: linear-gradient(180deg, #8f3e2a, #6f2d1f) !important;
      color: #fff7ee;
      box-shadow: 0 10px 22px rgba(111, 45, 31, 0.3);
    }
  `;

  const removedCache = new Map();

  function getTitleLinks() {
    for (const selector of TITLE_SELECTORS) {
      const links = document.querySelectorAll(selector);
      if (links.length > 0) return Array.from(links).filter((link) => link?.href);
    }
    return [];
  }

  function normalizeUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return `${parsed.pathname}${parsed.search}`.replace(/\/+$/, "");
    } catch {
      return String(url || "");
    }
  }

  function paperKey(url) {
    return normalizeUrl(url).toLowerCase();
  }

  function createId(seed) {
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
      hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  function isCnkiPage() {
    return (
      location.hostname.includes("cnki") ||
      getTitleLinks().length > 0 ||
      Boolean(document.querySelector(".result-table-list, #gridTable"))
    );
  }

  function toAccessibleLink(link, useWebVPN) {
    if (!useWebVPN) return link;
    return `${location.origin}${link.replace(/^(https?:\/\/)?(www\.)?[^/]+/, "")}`;
  }

  function extractFromRow(linkElement) {
    const row = linkElement.closest("tr") || linkElement.closest(".list-item");
    const sourceAnchor = row?.querySelector(".source a");

    return {
      title: linkElement.textContent.trim(),
      detailUrl: linkElement.href,
      date: row?.querySelector(".date")?.textContent?.trim() || "",
      quote: row?.querySelector(".quote")?.textContent?.trim() || "0",
      download: row?.querySelector(".download")?.textContent?.trim() || "0",
      source: sourceAnchor?.textContent?.trim() || "",
      sourceUrl: sourceAnchor?.href || "",
    };
  }

  async function getPapers() {
    const data = await chrome.storage.local.get(["cnkiPapers"]);
    return Array.isArray(data.cnkiPapers) ? data.cnkiPapers : [];
  }

  async function togglePaper(info) {
    const items = await getPapers();
    const key = paperKey(info.detailUrl);
    const index = items.findIndex((item) => paperKey(item.detailUrl) === key);

    if (index >= 0) {
      removedCache.set(key, items[index]);
      items.splice(index, 1);
      await chrome.storage.local.set({ cnkiPapers: items });
      return false;
    }

    const cached = removedCache.get(key);
    if (cached) {
      removedCache.delete(key);
      items.push(cached);
    } else {
      items.push({
        id: createId(key),
        title: info.title,
        detailUrl: info.detailUrl,
        date: info.date || "",
        quote: info.quote || "0",
        download: info.download || "0",
        source: info.source || "",
        sourceUrl: info.sourceUrl || "",
        author: "",
        pdfLink: "",
        keywords: "",
        abstract: "",
        level: "Wait",
      });
    }

    await chrome.storage.local.set({ cnkiPapers: items });
    return true;
  }

  async function addAllOnPage(useWebVPN) {
    const links = getTitleLinks();
    if (links.length === 0) return { ok: false, error: "no_links" };

    const items = await getPapers();
    const existing = new Set(items.map((item) => paperKey(item.detailUrl)));
    let added = 0;

    for (const link of links) {
      const info = extractFromRow(link);
      info.detailUrl = toAccessibleLink(link.href, useWebVPN);
      const key = paperKey(info.detailUrl);
      if (existing.has(key)) continue;

      items.push({
        id: createId(key),
        title: info.title,
        detailUrl: info.detailUrl,
        date: info.date || "",
        quote: info.quote || "0",
        download: info.download || "0",
        source: info.source || "",
        sourceUrl: info.sourceUrl || "",
        author: "",
        pdfLink: "",
        keywords: "",
        abstract: "",
        level: "Wait",
      });

      existing.add(key);
      added += 1;
    }

    await chrome.storage.local.set({ cnkiPapers: items });
    return { ok: true, added, total: links.length };
  }

  async function injectButtons() {
    const links = getTitleLinks();
    if (links.length === 0) return;

    const items = await getPapers();
    const collected = new Set(items.map((item) => paperKey(item.detailUrl)));

    for (const link of links) {
      const parent = link.parentNode;
      if (!parent) continue;

      let button = link.nextElementSibling;
      if (!button || !button.classList?.contains("cnki-atlas-trigger")) {
        if (parent.querySelector(":scope > .cnki-atlas-trigger")) continue;
        button = document.createElement("button");
        button.className = "cnki-atlas-trigger";

        button.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();

          const { useWebVPN = false } = await chrome.storage.local.get(["useWebVPN"]);
          const info = extractFromRow(link);
          info.detailUrl = toAccessibleLink(link.href, useWebVPN);
          const added = await togglePaper(info);
          button.classList.toggle("collected", added);
          button.textContent = added ? "✓" : "+";
          button.title = added ? "已加入 Atlas 队列，点击取消" : "加入 Atlas 队列";
        });

        if (link.nextSibling) parent.insertBefore(button, link.nextSibling);
        else parent.appendChild(button);
      }

      const directKey = paperKey(link.href);
      const vpnKey = paperKey(toAccessibleLink(link.href, true));
      const active = collected.has(directKey) || collected.has(vpnKey);
      button.classList.toggle("collected", active);
      button.textContent = active ? "✓" : "+";
      button.title = active ? "已加入 Atlas 队列，点击取消" : "加入 Atlas 队列";
    }
  }

  function syncButtons(papers) {
    const collected = new Set((papers || []).map((item) => paperKey(item.detailUrl)));
    document.querySelectorAll(".cnki-atlas-trigger").forEach((button) => {
      const link = button.previousElementSibling;
      if (!link?.href) return;
      const active = collected.has(paperKey(link.href)) || collected.has(paperKey(toAccessibleLink(link.href, true)));
      button.classList.toggle("collected", active);
      button.textContent = active ? "✓" : "+";
      button.title = active ? "已加入 Atlas 队列，点击取消" : "加入 Atlas 队列";
    });
  }

  function activate() {
    if (window.__cnkiAtlasActivated) return;
    window.__cnkiAtlasActivated = true;

    document.head.appendChild(styleTag);
    injectButtons();

    let timer = null;
    new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        injectButtons();
      }, 220);
    }).observe(document.body, { childList: true, subtree: true });

    chrome.storage.onChanged.addListener((changes) => {
      if (changes.cnkiPapers) syncButtons(changes.cnkiPapers.newValue || []);
    });
  }

  if (isCnkiPage()) {
    activate();
  } else {
    window.setTimeout(() => {
      if (isCnkiPage()) activate();
    }, 1800);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "PING") {
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "ADD_ALL_PAGE") {
      addAllOnPage(Boolean(message.useWebVPN)).then(sendResponse);
      return true;
    }
  });
})();
