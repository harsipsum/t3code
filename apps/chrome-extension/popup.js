const status = document.querySelector("#status");
document.querySelector("#extension-id").textContent = chrome.runtime.id;
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response.ok) throw new Error(response.error);
  return response.result;
}
async function showState() {
  const result = await request({ action: "status" });
  status.textContent = result.connected
    ? `Connected to Open Harness CUA. ${result.tabs.length} tab(s) allowed.`
    : result.error;
}
function action(selector, callback) {
  document.querySelector(selector).addEventListener("click", async () => {
    try {
      status.textContent = "Working…";
      await callback();
    } catch (error) {
      status.textContent = error.message;
    }
  });
}
action("#allow", async () => {
  await request({ action: "allow", tabId: tab?.id });
  await showState();
});
action("#revoke", async () => {
  await request({ action: "revoke", tabId: tab?.id });
  await showState();
});
async function exportSession(scope) {
  if (!tab?.url || !/^https?:\/\//.test(tab.url)) throw new Error("Choose an HTTP(S) tab first.");
  const site = new URL(tab.url);
  const origin = `${site.protocol}//${site.hostname}`;
  const granted = await chrome.permissions.request({
    origins: scope === "all-sites" ? ["<all_urls>"] : [`${origin}/*`],
  });
  if (!granted) throw new Error("Cookie access was not granted. Nothing was exported.");
  const result = await request({
    action: "export",
    tabId: tab.id,
    scope,
    profileName: document.querySelector("#profile").value || "Chrome session",
  });
  status.textContent = `Saved ${result.cookieCount} cookies (${result.scope}).\n${result.path}\nChoose this file in a compatible browser-profile importer.`;
}
action("#export", () => exportSession("current-domain"));
action("#export-all", () => exportSession("all-sites"));
await showState().catch((error) => {
  status.textContent = error.message;
});
