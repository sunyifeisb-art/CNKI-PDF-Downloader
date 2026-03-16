chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function handleFetchText({ url, referrer }) {
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    redirect: "follow",
    referrer: referrer || undefined,
  });

  return {
    ok: response.ok,
    status: response.status,
    text: await response.text(),
    finalUrl: response.url,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return;

  const task = async () => {
    try {
      if (message.type === "FETCH_TEXT") return await handleFetchText(message);
      return { ok: false, error: "unknown_type" };
    } catch (error) {
      return { ok: false, error: error?.message || "unknown_error" };
    }
  };

  task().then(sendResponse);
  return true;
});
