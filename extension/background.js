// RockReader extension: grab readable text from the page (or the selection) and post it to the server.

const DEFAULTS = { server: "http://localhost:8880", voice: "af_heart" };

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "read-selection", title: "Read selection with RockReader", contexts: ["selection"] });
  chrome.contextMenus.create({ id: "read-page", title: "Read this page with RockReader", contexts: ["page"] });
});

chrome.action.onClicked.addListener((tab) => readPage(tab));
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "read-selection") sendText(tab, { title: tab.title, text: info.selectionText, source_url: tab.url });
  else readPage(tab);
});

async function readPage(tab) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["Readability.js", "content.js"],
    });
    if (!result || !result.text || result.text.trim().length < 50) throw new Error("No readable text found on this page.");
    await sendText(tab, { title: result.title || tab.title, text: result.text, source_url: tab.url });
  } catch (err) {
    notify(tab, `RockReader: ${err.message}`);
  }
}

async function sendText(tab, body) {
  const { server, voice } = await chrome.storage.sync.get(DEFAULTS);
  const base = server.replace(/\/+$/, "");
  try {
    const r = await fetch(`${base}/api/docs/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, voice }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `${r.status} ${r.statusText}`);
    const meta = await r.json();
    chrome.tabs.create({ url: `${base}/#${meta.id}` });
  } catch (err) {
    notify(tab, `RockReader: could not reach ${base} (${err.message}). Check the server address in the extension options.`);
  }
}

function notify(tab, message) {
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (msg) => {
      const el = document.createElement("div");
      el.textContent = msg;
      el.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;background:#c8501e;color:#fff;padding:12px 16px;border-radius:8px;font:14px system-ui;max-width:360px;box-shadow:0 4px 16px rgba(0,0,0,.3)";
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 6000);
    },
    args: [message],
  }).catch(() => {});
}
