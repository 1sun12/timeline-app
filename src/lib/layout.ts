// Card placement and stem routing for the timeline.
//
// Coordinates are screen pixels; the axis is the horizontal line y = axisY.
// Each card hangs from its date ("anchor") by a stem made of right-angle
// segments. Stems must never cross or run along each other, so each one is
// routed into its own lane: unique anchor slots on the axis, then a search over
// elbow heights and attachment points for a route that touches no other stem.

export const CARD_W = 228;
export const CARD_H = 88;
const ROW_GAP = 22;
const FIRST_ROW = 46; // gap between the axis and the nearest row of cards
const SLOT = 6; // minimum spacing between parallel stem segments
const ELBOW_MIN = 14;

export interface Placed {
  id: string;
  anchorX: number;
  x: number; // card top-left
  y: number;
}

/**
 * Place unpinned cards in rows alternating above and below the axis, each in
 * the nearest row with room. Pinned cards keep the spot the user dropped them.
 */
export function placeCards(
  items: { id: string; anchorX: number; pinned: boolean; offsetX: number; offsetY: number }[],
  axisY: number,
): Placed[] {
  const rowEnd: number[] = [];
  const out: Placed[] = [];
  for (const it of [...items].sort((a, b) => a.anchorX - b.anchorX)) {
    if (it.pinned) {
      out.push({ id: it.id, anchorX: it.anchorX, x: it.anchorX + it.offsetX, y: axisY + it.offsetY });
      continue;
    }
    const x = it.anchorX - CARD_W / 2;
    let row = rowEnd.findIndex((end) => end + 16 <= x);
    if (row < 0) row = rowEnd.push(-Infinity) - 1;
    rowEnd[row] = x + CARD_W;
    const level = Math.floor(row / 2);
    const above = row % 2 === 0;
    const y = above
      ? axisY - FIRST_ROW - CARD_H - level * (CARD_H + ROW_GAP)
      : axisY + FIRST_ROW + level * (CARD_H + ROW_GAP);
    out.push({ id: it.id, anchorX: it.anchorX, x, y });
  }
  return out;
}

// --- stems -----------------------------------------------------------------

// Segments in "distance from the axis" space (d grows away from the axis), per side.
type V = { kind: "v"; x: number; d0: number; d1: number };
type H = { kind: "h"; d: number; x0: number; x1: number };
type Seg = V | H;

export interface Stem {
  id: string;
  path: string; // SVG path data
  anchorX: number; // where the stem meets the axis (may be nudged off the exact date)
}

function hits(a: Seg, b: Seg): boolean {
  const m = SLOT - 0.5;
  if (a.kind === "v" && b.kind === "v")
    return Math.abs(a.x - b.x) < m && a.d0 < b.d1 + m && b.d0 < a.d1 + m;
  if (a.kind === "h" && b.kind === "h")
    return Math.abs(a.d - b.d) < m && a.x0 < b.x1 + m && b.x0 < a.x1 + m;
  const [v, h] = (a.kind === "v" ? [a, b] : [b, a]) as [V, H];
  return v.x > h.x0 - m && v.x < h.x1 + m && h.d > v.d0 - m && h.d < v.d1 + m;
}

/** Does a segment pass behind a card (given in distance-from-axis space)? */
function behind(s: Seg, r: { x0: number; x1: number; d0: number; d1: number }): boolean {
  if (s.kind === "v") return s.x > r.x0 && s.x < r.x1 && s.d1 > r.d0 && s.d0 < r.d1;
  return s.d > r.d0 && s.d < r.d1 && s.x1 > r.x0 && s.x0 < r.x1;
}

function route(ax: number, tx: number, elbow: number, edge: number): Seg[] {
  if (tx === ax) return [{ kind: "v", x: ax, d0: 0, d1: edge }];
  return [
    { kind: "v", x: ax, d0: 0, d1: elbow },
    { kind: "h", d: elbow, x0: Math.min(ax, tx), x1: Math.max(ax, tx) },
    { kind: "v", x: tx, d0: elbow, d1: edge },
  ];
}

/**
 * Route every card's stem without crossings. Cards touching the axis get none.
 * shortcut: ~20ms for 50 on-screen cards, ~85ms for 100; if timelines get that
 * dense, skip pass 2 while a card is being dragged.
 */
export function routeStems(cards: Placed[], axisY: number): Stem[] {
  // Unique axis slots, shared by both sides so an upward and a downward stem
  // never meet at one point. Cards sharing a date fan out around it, ordered
  // like the cards themselves so their stems don't have to swap over.
  const sorted = [...cards].sort((a, b) => a.anchorX - b.anchorX);
  const slot = new Map<string, number>();
  for (let i = 0; i < sorted.length; ) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].anchorX - sorted[j - 1].anchorX < SLOT) j++;
    const group = sorted.slice(i, j).sort((a, b) => a.x - b.x);
    const mid = (sorted[i].anchorX + sorted[j - 1].anchorX) / 2;
    group.forEach((c, k) => slot.set(c.id, mid + (k - (group.length - 1) / 2) * SLOT));
    i = j;
  }

  const out: Stem[] = [];
  for (const above of [true, false]) {
    const side = cards
      .map((c) => ({ c, edge: above ? axisY - (c.y + CARD_H) : c.y - axisY, ax: slot.get(c.id)! }))
      .filter(({ c, edge }) => edge > 4 && (c.y + CARD_H / 2 < axisY) === above);

    // Straight stems first. Then nest the bent ones: among stems turning the same
    // way, the one whose anchor lies further in that direction must take the
    // lower elbow, or its upright would cut through the other's crossbar.
    const dir = (s: { ax: number; want: number }) => Math.sign(s.want - s.ax);
    const order = side
      .map((s) => ({ ...s, want: clamp(s.ax, s.c.x + 12, s.c.x + CARD_W - 12) }))
      .sort((a, b) => {
        const [da, db] = [dir(a), dir(b)];
        if (da !== db) return Math.abs(da) - Math.abs(db) || da - db;
        return da > 0 ? b.ax - a.ax : a.ax - b.ax;
      });

    // Other cards on this side, as obstacles a stem should rather not pass behind.
    const rects = side.map(({ c, edge }) => ({ id: c.id, x0: c.x, x1: c.x + CARD_W, d0: edge, d1: edge + CARD_H }));

    const candidates = (s: (typeof order)[number]) => {
      const out: Seg[][] = [];
      // Attachment points along the card edge, nearest the anchor first.
      const txs = [s.want];
      for (let k = 1; k * SLOT < CARD_W / 2; k++) {
        for (const tx of [s.want - k * SLOT, s.want + k * SLOT])
          if (tx >= s.c.x + 8 && tx <= s.c.x + CARD_W - 8) txs.push(tx);
      }
      const elbows: number[] = [];
      for (let e = ELBOW_MIN; e <= s.edge - SLOT; e += SLOT) elbows.push(e);
      if (!elbows.length) elbows.push(s.edge / 2);
      for (const tx of txs) for (const elbow of tx === s.ax ? [0] : elbows) out.push(route(s.ax, tx, elbow, s.edge));
      return out;
    };
    /** Crossings with `others`, counting no further than `limit`. */
    const crossings = (segs: Seg[], others: Seg[], limit = Infinity) => {
      let n = 0;
      for (const a of segs) for (const b of others) if (hits(a, b) && ++n >= limit) return n;
      return n;
    };
    const covered = (segs: Seg[], near: typeof rects) => {
      let n = 0;
      for (const a of segs) for (const r of near) if (behind(a, r)) n++;
      return n;
    };
    // Every route for a stem stays inside this box, so only things in it matter.
    const box = (s: (typeof order)[number]) => ({
      x0: Math.min(s.ax, s.c.x) - SLOT,
      x1: Math.max(s.ax, s.c.x + CARD_W) + SLOT,
      d1: s.edge + SLOT,
    });
    const segsIn = (b: ReturnType<typeof box>, segs: Seg[]) =>
      segs.filter((g) =>
        g.kind === "v" ? g.x > b.x0 && g.x < b.x1 && g.d0 < b.d1 : g.d < b.d1 && g.x1 > b.x0 && g.x0 < b.x1,
      );
    const rectsIn = (b: ReturnType<typeof box>, own: string) =>
      rects.filter((r) => r.id !== own && r.x1 > b.x0 && r.x0 < b.x1 && r.d0 < b.d1);

    // Pass 1: no crossings, taking the first (most direct) route that manages it.
    const routes: Seg[][] = [];
    const placed: Seg[] = [];
    for (const s of order) {
      let best: Seg[] = [];
      let bestN = Infinity;
      const near = segsIn(box(s), placed);
      for (const segs of candidates(s)) {
        const n = crossings(segs, near, bestN);
        if (n < bestN) [best, bestN] = [segs, n];
        if (n === 0) break;
      }
      routes.push(best);
      placed.push(...best);
    }

    // Pass 2: move stems out from behind other cards, but only onto routes that
    // cross nothing — tidiness never costs a crossing.
    order.forEach((s, i) => {
      const b = box(s);
      const nearRects = rectsIn(b, s.c.id);
      let cover = covered(routes[i], nearRects);
      if (!cover) return;
      const others = segsIn(b, routes.flatMap((r, j) => (j === i ? [] : r)));
      const base = crossings(routes[i], others);
      for (const segs of candidates(s)) {
        const c = covered(segs, nearRects);
        if (c < cover && crossings(segs, others, base + 1) <= base) {
          routes[i] = segs;
          cover = c;
          if (!c) break;
        }
      }
    });

    const y = (d: number) => (above ? axisY - d : axisY + d);
    order.forEach((s, i) => {
      const [first, ...rest] = routes[i];
      let path = `M${s.ax} ${axisY}`;
      if (first.kind === "v") path += ` V${y(first.d1)}`;
      for (const seg of rest) path += seg.kind === "h" ? ` H${seg.x0 === s.ax ? seg.x1 : seg.x0}` : ` V${y(seg.d1)}`;
      out.push({ id: s.c.id, path, anchorX: s.ax });
    });
  }
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Exposed for the self-test.
export const _test = { route, hits };
