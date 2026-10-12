/** An owned Chromium profile, a controlled localhost cookie, and actual extension/native APIs. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { homeDir, repoRoot } from "../src/config.mjs";
import { ensureBroker, bridgeFetch } from "../src/broker.mjs";

const browserPath = process.argv[process.argv.indexOf("--browser") + 1];
if (!process.argv.includes("--browser") || !browserPath)
  throw new Error("Pass --browser with the existing Chromium executable path.");
const keepOpen = process.argv.includes("--keep-open");
const fixturePort = process.argv.includes("--port")
  ? Number(process.argv[process.argv.indexOf("--port") + 1])
  : 0;
const extensionId = "imnnjncafjnhhebhjkaoiobegpjahnhb";
const proofDir = join(homeDir, "proofs", randomUUID());
const profileDir = join(proofDir, "chrome-profile");
const extensionDir = join(proofDir, "extension");
await mkdir(proofDir, { recursive: true });
await cp(join(repoRoot, "apps/chrome-extension"), extensionDir, { recursive: true });
const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
// The test fixture grants only its own localhost origin. The real unpacked
// extension instead asks the user through its popup, and is never modified.
manifest.host_permissions = ["http://127.0.0.1/*"];
await writeFile(join(extensionDir, "manifest.json"), JSON.stringify(manifest));
const observed = { input: "", clicks: 0, entered: false };
const fixture = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/protected") {
    const authenticated = (request.headers.cookie || "")
      .split(/;\s*/)
      .includes("t3_cua_demo=controlled_local_test");
    response.statusCode = authenticated ? 200 : 401;
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<html><head><title>T3 session import proof</title></head><body><h1>${authenticated ? "SIGNED_IN: imported session accepted" : "SIGNED_OUT: no imported session"}</h1></body></html>`,
    );
    return;
  }
  if (url.pathname === "/observe") {
    if (url.searchParams.has("input")) observed.input = url.searchParams.get("input");
    if (url.searchParams.has("click")) observed.clicks++;
    if (url.searchParams.has("enter")) observed.entered = true;
    response.end("ok");
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.setHeader(
    "Set-Cookie",
    "t3_cua_demo=controlled_local_test; Path=/; HttpOnly; SameSite=Lax",
  );
  response.end(
    `<!doctype html><html><head><title>T3 controlled browser proof</title></head><body style="font:20px system-ui;padding:30px"><h1>T3 controlled browser proof</h1><label>Demo name <input id="name" aria-label="Demo name"></label><label>Password <input type="password" value="password-must-be-redacted" aria-label="Password"></label><button id="button">Confirm demo</button><p id="result">Waiting</p><div style="height:1300px"></div><p>Scroll destination</p><script>nameInput=document.querySelector('#name');nameInput.oninput=()=>fetch('/observe?input='+encodeURIComponent(nameInput.value));nameInput.onkeydown=e=>{if(e.key==='Enter')fetch('/observe?enter=1')};document.querySelector('#button').onclick=()=>{document.querySelector('#result').textContent='Clicked correctly';fetch('/observe?click=1')}</script></body></html>`,
  );
});
await new Promise((done, reject) => {
  fixture.once("error", reject);
  fixture.listen(fixturePort, "127.0.0.1", done);
});
const testUrl = `http://127.0.0.1:${fixture.address().port}`;
const cleanProtected = await fetch(`${testUrl}/protected`);
assert.equal(cleanProtected.status, 401);
assert.equal(cleanProtected.headers.get("set-cookie"), null);
assert.match(await cleanProtected.text(), /SIGNED_OUT/);
const broker = await ensureBroker(homeDir);
const browser = spawn(
  browserPath,
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    testUrl,
  ],
  { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] },
);
let browserClient;
let extensionClient;
let stopped = false;
async function close() {
  if (stopped) return;
  stopped = true;
  browserClient?.close();
  extensionClient?.close();
  browser.kill();
  fixture.closeAllConnections();
  await new Promise((done) => fixture.close(done));
  await broker.close();
}
process.on("SIGINT", () => void close().then(() => process.exit(0)));
process.on("SIGTERM", () => void close().then(() => process.exit(0)));
process.stdin.on("data", (chunk) => {
  if (chunk.toString().includes("stop")) void close().then(() => process.exit(0));
});

async function until(read, ready, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = await read();
      if (ready(result)) return result;
    } catch {
      /* Startup progress, no action is replayed. */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Controlled browser startup did not reach the expected state.");
}

async function cdpSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((done, reject) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      message.error
        ? request.reject(new Error(message.error.message))
        : request.resolve(message.result);
    }
  });
  return {
    send(method, params = {}) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

try {
  const activePort = await until(
    () => readFile(join(profileDir, "DevToolsActivePort"), "utf8"),
    (value) => value.includes("\n"),
  );
  const debugPort = Number(activePort.split("\n")[0]);
  const root = `http://127.0.0.1:${debugPort}`;
  const version = await (await fetch(`${root}/json/version`)).json();
  browserClient = await cdpSocket(version.webSocketDebuggerUrl);
  await browserClient.send("Target.createTarget", { url: testUrl });
  await browserClient.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/popup.html`,
  });
  const popup = await until(
    async () =>
      (await (await fetch(`${root}/json/list`)).json()).find((target) =>
        target.url.startsWith(`chrome-extension://${extensionId}/popup.html`),
      ),
    (value) => value?.webSocketDebuggerUrl,
  );
  extensionClient = await cdpSocket(popup.webSocketDebuggerUrl);
  async function evaluate(expression) {
    const response = await extensionClient.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails)
      throw new Error(response.exceptionDetails.text || "Extension evaluation failed.");
    return response.result.value;
  }
  const tabId = await until(
    () =>
      evaluate(
        `chrome.tabs.query({}).then(tabs=>tabs.find(tab=>tab.url?.startsWith(${JSON.stringify(testUrl)}))?.id)`,
      ),
    (value) => typeof value === "number",
  );
  assert.equal(typeof tabId, "number");
  const allowed = await evaluate(`chrome.runtime.sendMessage({action:'allow',tabId:${tabId}})`);
  assert.equal(allowed.ok, true, allowed.error);
  console.log(
    JSON.stringify({
      milestone: "test-tab-allowed",
      tabId,
      popupStatus: await evaluate("chrome.runtime.sendMessage({action:'status'})"),
    }),
  );
  let lastPopupStatus;
  try {
    await until(
      async () => {
        lastPopupStatus = await evaluate("chrome.runtime.sendMessage({action:'status'})");
        return bridgeFetch(broker.connection, "/status");
      },
      (value) => value.connected && value.controlledTabs.some((tab) => tab.tabId === tabId),
    );
  } catch (error) {
    throw new Error(`${error.message} Popup: ${JSON.stringify(lastPopupStatus)}`);
  }
  const call = (action, args = {}) =>
    bridgeFetch(broker.connection, "/call", { action, args: { tabId, ...args } });
  let snapshot = await call("snapshot");
  assert.match(snapshot.text, /Demo name/);
  assert.doesNotMatch(snapshot.text, /password-must-be-redacted/);
  const inputRef = snapshot.text
    .split("\n")
    .find((line) => line.includes('textbox "Demo name"'))
    ?.match(/^\[(e\d+)\]/)?.[1];
  assert.ok(inputRef, "Name field was not returned with a ref.");
  await call("type", {
    snapshotId: snapshot.snapshotId,
    ref: inputRef,
    text: "T3 real input proof",
    clear: true,
  });
  await until(
    async () => observed.input,
    (value) => value === "T3 real input proof",
  );
  await call("key", { keys: ["Enter"] });
  await until(
    async () => observed.entered,
    (value) => value,
  );
  snapshot = await call("snapshot");
  assert.match(snapshot.text, /T3 real input proof/);
  const buttonRef = snapshot.text
    .split("\n")
    .find((line) => line.includes('button "Confirm demo"'))
    ?.match(/^\[(e\d+)\]/)?.[1];
  assert.ok(buttonRef);
  await call("click", { snapshotId: snapshot.snapshotId, ref: buttonRef });
  await until(
    async () => observed.clicks,
    (value) => value === 1,
  );
  await call("scroll", { deltaY: 300 });
  assert.ok((await call("snapshot")).viewport.scrollY > 0, "The page did not scroll.");
  await call("scroll", { deltaY: -10000 });
  const screenshot = await call("screenshot");
  const screenshotPath = join(proofDir, "chrome.png");
  await writeFile(screenshotPath, Buffer.from(screenshot.imageBase64, "base64"));
  const exported = await call("exportSession", { profileName: "Controlled localhost proof" });
  assert.equal(exported.cookieCount, 1);
  assert.ok(!JSON.stringify(exported).includes("controlled_local_test"));
  const saved = JSON.parse(await readFile(exported.path, "utf8"));
  assert.equal(saved.cookies[0].value, "controlled_local_test");
  assert.equal(saved.cookies[0].httpOnly, true);
  const refused = await call("navigate", { url: "https://example.com" }).then(
    () => null,
    (error) => error.message,
  );
  assert.match(refused, /approved site/);
  const receipt = {
    passed: true,
    testedAt: new Date().toISOString(),
    browserPid: browser.pid,
    debugPort,
    testUrl,
    tabId,
    extensionId,
    homeDir,
    fixtureScope:
      "owned fresh Chromium profile, localhost cookies only; no real user browser/session accessed",
    proofDir,
    checks: [
      "actual extension native messaging connected",
      "accessibility text snapshot",
      "trusted text insertion observed by page",
      "Enter key observed by page",
      "click observed by page",
      "scroll and PNG screenshot",
      "password redaction",
      "current-domain HttpOnly cookie saved locally without leaking into tool response",
      "unapproved-origin navigation refused",
      "protected endpoint returns signed-out/401 and never sets cookies in a clean request",
    ],
    protectedUrl: `${testUrl}/protected`,
    screenshotPath,
    sessionExport: exported,
  };
  await writeFile(join(proofDir, "receipt.json"), JSON.stringify(receipt, null, 2));
  await writeFile(join(homeDir, "chrome-proof-latest.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
  if (keepOpen) {
    console.log(
      "Controlled browser is available for the benchmark. Send stop on stdin to close only this owned browser and fixture.",
    );
    process.stdin.resume();
  } else await close();
} catch (error) {
  await close();
  throw error;
}
