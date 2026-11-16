// Run: npm test   (node's built-in runner; no extra dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeCards, routeStems, CARD_W } from "./layout.ts";
import { axisValue, dateAt, formatDate, ticks, tickLabel, toAstro } from "./time.ts";

type Seg = { x0: number; y0: number; x1: number; y1: number; id: string };

/** Parse "M x y V y H x ..." paths back into axis-aligned segments. */
function segments(stems: { id: string; path: string }[]): Seg[] {
  const out: Seg[] = [];
  for (const s of stems) {
    let x = 0, y = 0;
    for (const [, cmd, a, b] of s.path.matchAll(/([MVH])(-?[\d.e-]+)(?: (-?[\d.e-]+))?/g)) {
      const v = parseFloat(a);
      if (cmd === "M") [x, y] = [v, parseFloat(b)];
      else if (cmd === "V") { out.push({ x0: x, y0: y, x1: x, y1: v, id: s.id }); y = v; }
      else { out.push({ x0: x, y0: y, x1: v, y1: y, id: s.id }); x = v; }
    }
  }
  return out;
}

function touching(a: Seg, b: Seg): boolean {
  const e = 1; // closer than 1px counts as touching
  return (
    Math.min(a.x0, a.x1) <= Math.max(b.x0, b.x1) + e &&
    Math.min(b.x0, b.x1) <= Math.max(a.x0, a.x1) + e &&
    Math.min(a.y0, a.y1) <= Math.max(b.y0, b.y1) + e &&
    Math.min(b.y0, b.y1) <= Math.max(a.y0, a.y1) + e
  );
}

function assertNoCrossings(stems: { id: string; path: string }[]) {
  const segs = segments(stems);
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++)
      if (segs[i].id !== segs[j].id && touching(segs[i], segs[j]))
        assert.fail(`stems ${segs[i].id} and ${segs[j].id} cross: ${JSON.stringify([segs[i], segs[j]])}`);
}

const auto = (id: string, anchorX: number) => ({ id, anchorX, pinned: false, offsetX: 0, offsetY: 0 });

test("a pile of notes on the same date gets separate, non-crossing stems", () => {
  const cards = placeCards(Array.from({ length: 12 }, (_, i) => auto(`n${i}`, 500)), 0);
  const stems = routeStems(cards, 0);
  assert.equal(stems.length, 12);
  assert.equal(new Set(stems.map((s) => s.anchorX)).size, 12, "every stem has its own axis slot");
  assertNoCrossings(stems);
});

test("random spreads of notes route without crossings", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let round = 0; round < 25; round++) {
    const cards = placeCards(Array.from({ length: 30 }, (_, i) => auto(`n${i}`, rand() * 1600)), 0);
    assertNoCrossings(routeStems(cards, 0));
  }
});

test("cards dragged into a messy cluster still don't cross", () => {
  const items = Array.from({ length: 8 }, (_, i) => ({
    id: `p${i}`,
    anchorX: 400 + (i % 3) * 3,
    pinned: true,
    offsetX: (i % 2 ? 1 : -1) * (40 + i * 30) - CARD_W / 2,
    offsetY: -140 - i * 100,
  }));
  assertNoCrossings(routeStems(placeCards(items, 0), 0));
});

test("dates map to the axis across the BCE/AD boundary", () => {
  assert.equal(toAstro(-1), 0);
  assert.equal(axisValue({ year: 1 }) - axisValue({ year: -1 }), 1, "1 BCE is directly before 1 AD");
  assert.ok(axisValue({ year: 2024, month: 3 }) > axisValue({ year: 2024, month: 2, day: 29 }));
  assert.deepEqual(dateAt(axisValue({ year: -428, month: 6, day: 15 }) + 0.0001, 5000), { year: -428, month: 6, day: 15 });
  assert.equal(formatDate({ year: -428 }), "428 BCE");
  assert.equal(formatDate({ year: 1066, month: 10, day: 14, hour: 9, minute: 5 }), "14 Oct 1066, 09:05");
  assert.ok(!ticks(-50, 50, 5).some((t) => t.label === "0 AD"), "no year zero");
});

test("deep time formats and ticks sensibly", () => {
  assert.equal(formatDate({ year: -66_000_000 }), "66,000,000 BCE");
  assert.equal(tickLabel(-66_000_000), "66 million BCE");
  assert.equal(tickLabel(-4_540_000_000), "4.54 billion BCE");
  assert.equal(tickLabel(-250_000), "250,000 BCE");
  assert.equal(tickLabel(2_000_000), "2 million AD");
  // Big Bang to now across ~1200px: a handful of round billion-year ticks.
  const t = ticks(-13.8e9, 2026, 1200 / 13.8e9);
  assert.ok(t.length >= 5 && t.length <= 20, `${t.length} ticks`);
  assert.ok(t.every((k) => k.label.includes("billion") || k.label === ""), t.map((k) => k.label).join());
});

test("cards dragged near their dates never cross", () => {
  let seed = 3;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let round = 0; round < 100; round++) {
    const used: [number, number][] = [];
    const items = [];
    for (let i = 0; i < 25; i++) {
      const x = rand() * 1400;
      const y = (rand() < 0.5 ? -1 : 1) * (60 + rand() * 600) - (rand() < 0.5 ? 88 : 0);
      if (used.some(([ux, uy]) => Math.abs(ux - x) < CARD_W + 10 && Math.abs(uy - y) < 98) || Math.abs(y + 44) < 54) continue;
      used.push([x, y]);
      const anchorX = x + CARD_W / 2 + (rand() - 0.5) * 100;
      items.push({ id: `c${i}`, anchorX, pinned: true, offsetX: x - anchorX, offsetY: y });
    }
    assertNoCrossings(routeStems(placeCards(items, 0), 0));
  }
});
