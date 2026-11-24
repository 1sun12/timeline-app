// End-to-end UI test: drives the app's browser preview (sample data, mock
// backend) in headless Chromium with real mouse and keyboard input.
//
//   npm run dev                      # in one terminal (serves :1420)
//   CHROME=/path/to/chrome node tests/ui.mjs
//
// CHROME defaults to Playwright's cached headless shell if one is installed.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";

const URL = process.env.APP_URL ?? "http://localhost:1420/";
const CHROME = process.env.CHROME ?? findChrome();
function findChrome() {
  const root = `${process.env.HOME}/.cache/ms-playwright`;
  const dir = readdirSync(root).find((d) => d.startsWith("chromium_headless_shell"));
  return `${root}/${dir}/chrome-headless-shell-linux64/chrome-headless-shell`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ["--remote-debugging-port=9334", "--no-sandbox", "about:blank"], { stdio: "ignore" });
let pages;
for (let i = 0; i < 50 && !pages; i++) {
  try { pages = await (await fetch("http://127.0.0.1:9334/json/list")).json(); } catch { await sleep(200); }
}
const ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  pending.get(d.id)?.(d);
  pending.delete(d.id);
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });

/** Evaluate in the page and return the value (throws on page exceptions). */
async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.result.value;
}
async function center(selector, text) {
  const pos = await js(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = ${text ? `els.find(e => e.textContent.includes(${JSON.stringify(text)}) || e.title === ${JSON.stringify(text)})` : "els[0]"};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  })()`);
  if (!pos) throw new Error(`not found: ${selector} ${text ?? ""}`);
  return pos;
}
const mouse = (type, x, y, buttons = 0) =>
  send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
async function click(selector, text) {
  const [x, y] = await center(selector, text);
  await mouse("mouseMoved", x, y);
  await mouse("mousePressed", x, y, 1);
  await mouse("mouseReleased", x, y);
  await sleep(250);
}
async function drag(selector, text, dx, dy) {
  const [x, y] = await center(selector, text);
  await mouse("mouseMoved", x, y);
  await mouse("mousePressed", x, y, 1);
  for (let i = 1; i <= 10; i++) await mouse("mouseMoved", x + (dx * i) / 10, y + (dy * i) / 10, 1);
  await mouse("mouseReleased", x + dx, y + dy);
  await sleep(300);
}
const type = async (text) => (await send("Input.insertText", { text }), sleep(120));
const KEYS = { Enter: 13, Escape: 27, "0": 48, ",": 188, "-": 189, a: 65, n: 78 };
const CODES = { "0": "Digit0", ",": "Comma", "-": "Minus" };
async function key(k, modifiers = 0) {
  const p = { key: k, code: CODES[k] ?? (k.length === 1 ? `Key${k.toUpperCase()}` : k), windowsVirtualKeyCode: KEYS[k], modifiers };
  const typed = k === "Enter" ? "\r" : k.length === 1 && !modifiers ? k : undefined;
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...p, ...(typed ? { text: typed } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...p });
  await sleep(200);
}
const CTRL = 2;
const text = (sel) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e => e.textContent.trim())`);
const count = (sel) => js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const cardBox = (title) =>
  js(`(() => { const c = [...document.querySelectorAll('.card')].find(c => c.querySelector('.card-title').textContent === ${JSON.stringify(title)}); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, pinned: !!c.querySelector('.pin') }; })()`);

// --- harness ----------------------------------------------------------------
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(["PASS", name]);
  } catch (e) {
    results.push(["FAIL", name, e.message]);
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Stems must never touch each other except where each meets its own card.
const stemCrossings = () =>
  js(`(() => {
    const segs = [];
    for (const p of document.querySelectorAll('path.stem')) {
      let x = 0, y = 0, id = p;
      for (const [, c, a, b] of p.getAttribute('d').matchAll(/([MVH])(-?[\\d.e-]+)(?: (-?[\\d.e-]+))?/g)) {
        const v = +a;
        if (c === 'M') [x, y] = [v, +b];
        else if (c === 'V') { segs.push([x, y, x, v, id]); y = v; }
        else { segs.push([x, y, v, y, id]); x = v; }
      }
    }
    let n = 0;
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const [a, b] = [segs[i], segs[j]];
      if (a[4] === b[4]) continue;
      if (Math.min(a[0], a[2]) <= Math.max(b[0], b[2]) + 1 && Math.min(b[0], b[2]) <= Math.max(a[0], a[2]) + 1 &&
          Math.min(a[1], a[3]) <= Math.max(b[1], b[3]) + 1 && Math.min(b[1], b[3]) <= Math.max(a[1], a[3]) + 1) n++;
    }
    return n;
  })()`);

// --- tests ------------------------------------------------------------------
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await send("Page.navigate", { url: URL });
await sleep(2500);
await js("window.confirm = () => true; localStorage.clear(); 1");

await test("loads the Master timeline with its notes", async () => {
  ok((await text(".timelines li.active .name"))[0] === "Master", "Master not active");
  ok((await count(".sidebar .note")) === 10, "expected 10 notes in the sidebar");
  ok((await count(".card")) === 10, "expected 10 cards on the timeline");
});

await test("every card has a stem and no two stems cross", async () => {
  ok((await count("path.stem")) === (await count(".card")), "a card is missing its stem");
  const anchors = await js(`[...document.querySelectorAll('circle.anchor')].map(c => c.getAttribute('cx'))`);
  ok(new Set(anchors).size === anchors.length, "two stems share an axis point");
  ok((await stemCrossings()) === 0, "stems cross");
});

await test("master timeline cannot be deleted; others can", async () => {
  ok((await js(`[...document.querySelectorAll('.timelines li')][0].querySelector('[title="Delete timeline"]')`)) === null, "Master has a delete button");
});

await test("create, switch to and delete a timeline", async () => {
  await click('.section-head button[title="New timeline"]');
  await type("Research papers");
  await key("Enter");
  await sleep(300);
  ok((await text(".timelines li.active .name"))[0] === "Research papers", "new timeline not active");
  ok((await count(".card")) === 0, "new timeline should be empty");
  ok((await count(".empty.glass")) === 1, "empty-state hint missing");
  const [hx, hy] = await center(".timelines li.active");
  await mouse("mouseMoved", hx, hy); // row actions appear on hover
  await sleep(150);
  await click('.timelines li.active [title="Delete timeline"]');
  await sleep(300);
  ok(!(await text(".timelines .name")).includes("Research papers"), "timeline not deleted");
  ok((await text(".timelines li.active .name"))[0] === "Master", "did not fall back to Master");
});

await test("new note with a BCE date appears on the timeline", async () => {
  await click(".topbar .btn.primary");
  await type("Symposium");
  await click(".author");
  await type("Plato");
  await click('.date input[type="number"]');
  await key("a", CTRL);
  await type("385");
  await click(".date .segmented button", "BCE");
  await sleep(900);
  ok((await text(".panel .status"))[0] === "Saved", "note did not save");
  const card = await cardBox("Symposium");
  ok(card, "card not on the timeline");
  ok((await text(".card .card-date")).includes("385 BCE"), "card date wrong");
  ok((await count(".sidebar .note")) === 11, `sidebar lists ${JSON.stringify(await text(".sidebar .note-title"))} cards ${JSON.stringify(await text(".card-title"))}`);
});

await test("a note without a year is refused with a message", async () => {
  await click('.date input[type="number"]');
  await key("a", CTRL);
  await type(" ");
  await js(`(() => { const i = document.querySelector('.date input[type="number"]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  ok((await text(".panel .status .err"))[0]?.includes("year is required"), "no year-required message");
  await click('.date input[type="number"]');
  await type("385");
  await sleep(900);
});

await test("[[links]] render, resolve and open the linked note", async () => {
  await click(".panel .segmented button", "Write");
  await click(".cm-content");
  await type("Compare with [[Meditations]] and [[Phaedrus]].");
  await sleep(900);
  await click(".panel .segmented button", "Preview");
  ok((await count(".preview a.wikilink:not(.missing)")) === 1, "existing link not live");
  ok((await count(".preview a.wikilink.missing")) === 1, "dangling link not marked");
  await click(".preview a.wikilink", "Meditations");
  await sleep(400);
  ok((await js(`document.querySelector('.panel .title').value`)) === "Symposium", "side-panel link should not switch notes");
  await click(".sidebar .note", "Meditations");
  ok((await text(".backlinks button")).includes("Symposium"), "backlink missing");
});

await test("a dangling link starts a new note with that title", async () => {
  await click(".sidebar .note", "Symposium");
  await sleep(400);
  await click(".panel .segmented button", "Preview");
  await click(".preview a.wikilink.missing", "Phaedrus");
  await sleep(300);
  ok((await js(`document.querySelector('.panel .title').value`)) === "Phaedrus", "new note not titled from link");
  await key("Escape");
  ok((await count(".panel")) === 0, "Escape did not close the editor");
});

await test("dragging a card pins it where it is dropped", async () => {
  await key("0");
  await sleep(300);
  const before = await cardBox("Leviathan");
  await drag(".card", "Leviathan", -90, -140);
  const after = await cardBox("Leviathan");
  ok(after.pinned, "card not pinned");
  ok(Math.abs(after.x - before.x + 90) < 3 && Math.abs(after.y - before.y + 140) < 3, `card moved to ${after.x},${after.y}`);
  ok((await count(".panel")) === 0, "drag should not open the editor");
  ok((await stemCrossings()) === 0, "stems cross after the drag");
});

await test("the pinned spot survives zooming out and back", async () => {
  const before = await cardBox("Leviathan");
  await click('.tools [title="Zoom out (−)"]');
  await click('.tools [title="Zoom in (+)"]');
  const after = await cardBox("Leviathan");
  ok(Math.abs(after.x - before.x) < 2 && Math.abs(after.y - before.y) < 2, "pinned card drifted");
});

await test("unpinning returns a card to automatic placement", async () => {
  await click(".card .pin");
  ok(!(await cardBox("Leviathan")).pinned, "still pinned");
});

await test("zoom controls change the axis scale", async () => {
  const before = await text(".tick-label");
  await click('.tools [title="Zoom in (+)"]');
  await click('.tools [title="Zoom in (+)"]');
  const after = await text(".tick-label");
  ok(JSON.stringify(before) !== JSON.stringify(after), "ticks did not change");
  await key("0");
});

await test("mouse wheel zooms around the cursor and does not pan", async () => {
  await key("0");
  const [x, y] = await center(".stage");
  const before = await text(".tick-label");
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y: y + 200, deltaX: 0, deltaY: -400 });
  await sleep(300);
  const zoomedIn = await text(".tick-label");
  ok(JSON.stringify(before) !== JSON.stringify(zoomedIn), "wheel did not zoom");
  const axisBefore = await js(`document.querySelector('.tick').getAttribute('y1')`);
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y: y + 200, deltaX: 0, deltaY: 400 });
  await sleep(300);
  ok((await js(`document.querySelector('.tick').getAttribute('y1')`)) === axisBefore, "wheel moved the view vertically");
  await key("0");
});

await test("left-drag on empty space pans the timeline", async () => {
  const before = await text(".tick-label");
  const axis = await js(`document.querySelector('rect[fill="url(#axis-fade)"]').getAttribute('y')`);
  // Bottom-left of the stage is empty in the sample layout.
  const r = await js(`(() => { const b = document.querySelector('.stage').getBoundingClientRect(); return [b.x + 60, b.bottom - 40]; })()`);
  await mouse("mouseMoved", r[0], r[1]);
  await mouse("mousePressed", r[0], r[1], 1);
  for (let i = 1; i <= 10; i++) await mouse("mouseMoved", r[0] + i * 30, r[1] - i * 10, 1);
  await mouse("mouseReleased", r[0] + 300, r[1] - 100);
  await sleep(300);
  ok(JSON.stringify(await text(".tick-label")) !== JSON.stringify(before), "did not pan horizontally");
  ok((await js(`document.querySelector('rect[fill="url(#axis-fade)"]').getAttribute('y')`)) !== axis, "did not pan vertically");
  ok((await count(".panel")) === 0, "drag on empty space opened something");
  await key("0");
});

await test("search filters the note list", async () => {
  await click(".search input");
  await type("Plato");
  await sleep(200);
  ok((await count(".sidebar .note")) === 3, "expected 3 notes by Plato");
  await js(`(() => { const i = document.querySelector('.search input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
});

await test("theme toggle switches to matte black with its own accent", async () => {
  const light = await js(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
  await click('.tools [title="Toggle theme"]');
  ok((await js("document.documentElement.dataset.theme")) === "dark", "not dark");
  await sleep(450); // background colour transition
  const dark = await js(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
  ok(light !== dark && dark === "#d27a26", `dark accent is ${dark}`);
  ok((await js(`getComputedStyle(document.body).backgroundColor`)) === "rgb(17, 17, 16)", "background not matte black");
});

await test("accent colour can be changed from settings", async () => {
  await key(",", CTRL);
  await js(`document.querySelector('.swatches .swatch[title="#7f9de0"]').click()`);
  await sleep(150);
  ok((await js(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`)) === "#7f9de0", "accent not applied");
  await js(`document.querySelectorAll('.swatches')[1].querySelector('[title="Reset to default"]').click()`);
  await sleep(150);
});

await test("vim keybindings toggle in settings and apply to the editor", async () => {
  await js(`[...document.querySelectorAll('.toggle')].find(t => t.textContent.includes('Vim')).querySelector('input').click()`);
  await key("Escape");
  await click(".sidebar .note", "The Republic");
  await click(".panel .segmented button", "Write");
  await click(".cm-content");
  ok((await count(".cm-fat-cursor")) + (await count(".cm-vimMode")) > 0, "vim mode not active");
  await key("Escape");
});

await test("activity heat map shows a year of days and today's additions", async () => {
  await key("Escape");
  await click(".foot-btn", "Activity");
  ok((await count(".grid .week")) === 53, "expected 53 week columns");
  const stats = await text(".stat b");
  ok(Number(stats[0]) >= 11, `notes this year = ${stats[0]}`);
  ok((await text(".day li .t")).includes("Symposium"), "today's list missing the new note");
  const visible = await js(`(() => { const g = document.querySelector('.heat'); return g.scrollWidth <= g.clientWidth + 1; })()`);
  ok(visible, "heat map is clipped");
  await key("Escape");
});

await test("deleting a note removes its card", async () => {
  await click(".sidebar .note", "Symposium");
  await click('.panel [title="Delete note"]');
  await sleep(300);
  ok(!(await cardBox("Symposium")), "card still there");
  ok((await count(".sidebar .note")) === 10, "sidebar still lists it");
});

await test("side-panel links move the timeline to the linked card without leaving the note", async () => {
  await key("0");
  await click(".sidebar .note", "Politics");
  await click(".panel .segmented button", "Preview");
  await click(".preview a.wikilink", "The Republic");
  await sleep(200);
  ok((await js(`document.querySelector('.panel .title').value`)) === "Politics", "panel switched notes");
  ok(!(await js(`!!document.querySelector('.panel.full')`)), "side link opened the full view");
  const flashed = await js(`[...document.querySelectorAll('.card.flash .card-title')].map(e => e.textContent)`);
  ok(flashed.includes("The Republic"), `linked card not highlighted (${flashed})`);
  const box = await cardBox("The Republic");
  const stage = await js(`(() => { const r = document.querySelector('.stage').getBoundingClientRect(); return [r.x, r.right]; })()`);
  ok(box && box.x > stage[0] && box.x < stage[1], "linked card not brought into view");
});

await test("the expand button opens the note as a full document", async () => {
  await click('.panel [title^="Open as a full document"]');
  ok(await js(`!!document.querySelector('.panel.full')`), "not full screen");
  const w = await js(`document.querySelector('.panel.full').getBoundingClientRect().width`);
  ok(w >= 1400, `document view is only ${w}px wide`);
  ok((await count(".panel .segmented button")) >= 2, "write/preview toggle missing");
  await click(".panel .segmented button", "Write");
  ok((await count(".panel .cm-editor")) === 1, "markdown editor missing in full view");
  await click(".panel .segmented button", "Preview");
});

await test("links in the full document open the linked document", async () => {
  await click(".preview a.wikilink", "The Republic");
  await sleep(250);
  ok((await js(`document.querySelector('.panel .title').value`)) === "The Republic", "did not open the linked note");
  ok(await js(`!!document.querySelector('.panel.full')`), "left full screen");
  await click(".backlinks button", "Politics");
  ok((await js(`document.querySelector('.panel .title').value`)) === "Politics", "backlink did not open in full view");
});

await test("Escape leaves the full document, then closes the panel", async () => {
  await click(".panel .title");
  await key("Escape");
  ok(!(await js(`!!document.querySelector('.panel.full')`)) && (await count(".panel")) === 1, "Escape should return to the side panel");
  await key("Escape");
  ok((await count(".panel")) === 0, "second Escape should close the panel");
});

await test("double-clicking a card and Ctrl+Shift+F toggle the document view", async () => {
  const [x, y] = await center(".card", "The Iliad"); // left side, clear of the panel the first click opens
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 2 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 2 });
  await sleep(300);
  ok((await js(`document.querySelector('.panel.full .title')?.value`)) === "The Iliad", "double-click did not open the document");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "F", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: CTRL | 8 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "F", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: CTRL | 8 });
  await sleep(200);
  ok(!(await js(`!!document.querySelector('.panel.full')`)), "Ctrl+Shift+F did not leave full view");
  await key("Escape");
});

await test("only the BCE/AD divide is marked by default", async () => {
  await key("0");
  ok((await count(".strips")) === 0, "era ruler shown with nothing enabled");
  ok((await text(".era-label")).join() === "BCE,AD", "BCE/AD divide missing");
});

await test("era markers toggle from settings and time zooms out to billions of years", async () => {
  await key(",", CTRL);
  await js(`[...document.querySelectorAll('.toggle')].find(t => t.textContent.includes('Geologic time')).querySelector('input').click()`);
  await key("Escape");
  await click(".topbar h1");
  for (let i = 0; i < 44; i++) await send("Input.dispatchKeyEvent", { type: "keyDown", key: "-", code: "Minus", windowsVirtualKeyCode: 189, text: "-" });
  await sleep(400);
  ok((await text(".tick-label")).some((t) => t.includes("billion BCE")), `ticks: ${(await text(".tick-label")).join(" | ")}`);
  ok((await text(".strips .marker text")).includes("Archean"), `ruler labels: ${(await text(".strips text")).join(" | ")}; ticks: ${(await text(".tick-label")).join(" | ")}`);
  await key(",", CTRL);
  await js(`[...document.querySelectorAll('.toggle')].find(t => t.textContent.includes('Geologic time')).querySelector('input').click()`);
  await key("Escape");
  ok((await count(".strips")) === 0, "ruler still shown after turning the set off");
  await key("0");
});

await test("keyboard: ⌘/Ctrl+N opens a new note", async () => {
  await key("n", CTRL);
  ok((await js(`document.querySelector('.panel .title')?.value`)) === "", "no blank note opened");
  await key("Escape");
});

await test("security: note HTML is sanitized", async () => {
  // Parse the rendered HTML and inspect real elements and attributes, not text.
  const bad = await js(`import('/src/lib/markdown.ts').then((m) => {
    const html = [
      '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '[x](javascript:alert(1))',
      '<form action="https://attacker.example"><input type=password><button>Sign in</button></form>',
      '<iframe src="https://attacker.example"></iframe>', '<div style="position:fixed;inset:0">overlay</div>',
      '<style>body{display:none}</style>', '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
      '[[a" onmouseover="alert(1)]]',
    ].map((p) => m.render(p, () => true)).join('');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const found = [...doc.querySelectorAll('script, form, input, button, textarea, select, iframe, style')].map((e) => e.tagName);
    for (const e of doc.body.querySelectorAll('*'))
      for (const a of e.attributes)
        if (/^on|^style$/i.test(a.name) || /^\\s*javascript:/i.test(a.value)) found.push(e.tagName + '[' + a.name + ']');
    return found;
  })`);
  ok(bad.length === 0, `unsafe HTML survived: ${bad.join(", ")}`);
  ok((await js(`import('/src/lib/markdown.ts').then((m) => m.render('[[Republic]]', () => true))`)).includes('data-note="Republic"'), "wikilinks lost data-note");
});

for (const [status, name, err] of results) console.log(`${status === "PASS" ? "✔" : "✖"} ${name}${err ? `\n    ${err}` : ""}`);
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
chrome.kill();
process.exit(failed ? 1 : 0);
