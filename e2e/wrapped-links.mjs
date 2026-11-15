// Standalone browser regression: npm run e2e:hints (no running bb required).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import ts from "typescript";

// Load the real key handler and its modules without a separate bundler.
export async function moduleUrl(name) {
  const source = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
  let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const match of [...code.matchAll(/from "\.\/(\w+\.ts)"/g)]) {
    code = code.replace(match[0], `from "${await moduleUrl(match[1])}"`);
  }
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}

// Runs inside a real browser: layout and elementFromPoint cannot be mocked here.
export async function checkWrappedLinks(url) {
  const { createKeys, parseSettings } = await import(url);
  const keys = createKeys();
  keys.apply(parseSettings(undefined));
  const results = [];
  const key = (value) => window.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const hints = () => [...document.querySelectorAll(".bbium-hint")].filter((n) => n.style.display !== "none");
  const wrapped = 'prefix text <a href="#target">a wrapped link</a>';
  async function scenario(name, markup, setup, expected = 1, change) {
    key("Escape");
    document.body.innerHTML = `<main style="position:absolute;left:80px;top:80px;width:200px;font:20px/40px monospace">${markup}</main>`;
    const link = document.querySelector("a");
    let clicks = 0;
    const points = [];
    link.addEventListener("click", (e) => { e.preventDefault(); clicks++; });
    link.addEventListener("pointerdown", (e) => points.push(link.contains(document.elementFromPoint(e.clientX, e.clientY))));
    setup?.(link);
    key("f");
    check(hints().length === expected, `${name}: expected ${expected} hint(s), got ${hints().length}`);
    if (expected) {
      if (change) { await change(link); await frame(); }
      const hint = hints()[0];
      check(!!hint, `${name}: hint disappeared`);
      const x = Number.parseFloat(hint.style.left), y = Number.parseFloat(hint.style.top);
      check([...link.getClientRects()].some((r) => x >= r.left - 1 && x < r.right && y >= r.top - 1 && y < r.bottom), `${name}: hint must sit on a text fragment`);
      check(link.contains(document.elementFromPoint(x + 1, y + 1)), `${name}: hint must sit on a visible fragment`);
      for (const letter of hint.textContent) key(letter);
      check(clicks === 1, `${name}: link did not activate exactly once`);
      check(points.length === 1 && points[0], `${name}: pointer event missed the link`);
    } else {
      check(clicks === 0, `${name}: hidden link activated`);
    }
    results.push(name);
  }
  function cover(rect) {
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:fixed;z-index:10;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:white`;
    document.body.appendChild(overlay);
  }
  try {
    await scenario("single-line link", '<a href="#target">short link</a>');
    await scenario("wrapped link with empty bounding-box center", wrapped, (link) => {
      check(link.getClientRects().length === 2, "fixture did not wrap");
      const r = link.getBoundingClientRect();
      check(!link.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)), "fixture center must miss the link");
    });
    await scenario("first fragment covered", wrapped, (link) => cover(link.getClientRects()[0]));
    await scenario("fully covered link", wrapped, (link) => cover(link.getBoundingClientRect()), 0);
    await scenario("partially clipped fragment", `<div style="height:9px;overflow:hidden">${wrapped}</div>`, (link) => {
      const scroller = link.parentElement;
      scroller.scrollTop = 52;
    });
    await scenario("clipped at viewport edge", wrapped, (link) => { link.parentElement.style.top = "-52px"; });
    await scenario("hint follows scroll to another fragment", `<div style="height:40px;overflow:auto">${wrapped}</div>`, undefined, 1, async (link) => {
      link.parentElement.scrollTop = 40;
      link.parentElement.dispatchEvent(new Event("scroll"));
    });
    await scenario("hint follows reflow", wrapped, undefined, 1, async (link) => {
      link.parentElement.style.width = "160px";
      window.dispatchEvent(new Event("resize"));
    });
    // Cover a target after hints are shown: activation must recheck visibility.
    key("Escape");
    document.body.innerHTML = `<main style="margin:80px;width:200px;font:20px/40px monospace">${wrapped}</main>`;
    const link = document.querySelector("a");
    let clicks = 0;
    link.addEventListener("click", (e) => { e.preventDefault(); clicks++; });
    key("f");
    const label = hints()[0]?.textContent;
    check(!!label, "late overlay: missing initial hint");
    cover(link.getBoundingClientRect());
    for (const letter of label) key(letter);
    check(clicks === 0, "late overlay: covered link activated");
    results.push("overlay added before activation");
    return results;
  } finally {
    keys.dispose();
    document.body.replaceChildren();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = await moduleUrl("keys.ts");
  if (process.argv.includes("--prepare")) {
    // Also usable by an attached browser runner without launching another browser.
    console.log(JSON.stringify({ url, check: checkWrappedLinks.toString() }));
  } else {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const results = await page.evaluate(checkWrappedLinks, url);
      assert.deepEqual(errors, []);
      for (const name of results) console.log(`ok  ${name}`);
    } finally {
      await browser.close();
    }
  }
}
