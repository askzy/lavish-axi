import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createSdkJs } from "../src/server.js";

const chromeBinary = [
  process.env.LAVISH_AXI_CHROME_BINARY,
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((binary) => binary && existsSync(binary));
const skip = process.env.LAVISH_AXI_BROWSER_E2E !== "1" || !chromeBinary;

async function probeBrowser(script) {
  const temp = await mkdtemp(path.join(tmpdir(), "lavish-sdk-controls-"));
  try {
    const file = path.join(temp, "probe.html");
    const sdkFile = path.join(temp, "sdk.js");
    await writeFile(sdkFile, createSdkJs("isolated-probe", 1, "isolated-token"));
    await writeFile(
      file,
      `<!doctype html><html><body><script src="sdk.js"></script><script>
      window.addEventListener("load", () => {
        try { const result = (() => { ${script} })(); document.body.dataset.result = JSON.stringify(result); }
        catch (error) { document.body.dataset.error = String(error.stack); }
      });</script></body></html>`,
    );
    const result = spawnSync(
      chromeBinary,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${path.join(temp, "profile")}`,
        "--virtual-time-budget=1000",
        "--dump-dom",
        pathToFileURL(file).href,
      ],
      { encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /data-error=/);
    const encoded = result.stdout.match(/data-result="([^"]*)"/)?.[1];
    assert.ok(encoded, result.stdout);
    return JSON.parse(encoded.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test("real browser: native and ARIA controls work while links stay annotatable", { skip }, async () => {
  const result = await probeBrowser(`
    const box = document.createElement("div");
    box.innerHTML = '<button id="native"><span>Choose</span></button><input id="checkbox" type="checkbox"><div id="widget" role="menuitem"><span>Choose</span><a href="#destination"><span id="link">Read more</span></a></div>';
    document.body.append(box);
    let nativeClicks = 0, widgetClicks = 0;
    document.getElementById("native").onclick = () => nativeClicks++;
    document.getElementById("widget").onclick = () => widgetClicks++;
    document.querySelector("#native span").click();
    document.getElementById("checkbox").click();
    document.querySelector("#widget > span").click();
    const cursor = getComputedStyle(document.querySelector("#widget > span")).cursor;
    const linkCursor = getComputedStyle(document.getElementById("link")).cursor;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.getElementById("link").dispatchEvent(click);
    return { nativeClicks, widgetClicks, checked: document.getElementById("checkbox").checked, cursor, linkCursor, prevented: click.defaultPrevented };
  `);
  assert.deepEqual(result, {
    nativeClicks: 1,
    widgetClicks: 1,
    checked: true,
    cursor: "pointer",
    linkCursor: "default",
    prevented: true,
  });
});
