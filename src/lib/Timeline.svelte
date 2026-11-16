<script lang="ts">
  import { untrack } from "svelte";
  import { Pin } from "@lucide/svelte";
  import type { Note } from "./api";
  import { axisValue, dateAt, formatDate, ticks, type Dated } from "./time";
  import { placeCards, routeStems, CARD_W, CARD_H, type Placed } from "./layout";
  import { linksIn, titleKey } from "./markdown";
  import type { Marker, MarkerSet } from "./eras";

  interface Props {
    notes: Note[];
    timelineId: string;
    selectedId: string | null;
    showLinks: boolean;
    markerSets: MarkerSet[];
    flashId: string | null;
    onOpenFull: (id: string) => void;
    onSelect: (id: string) => void;
    onMove: (note: Note, pinned: boolean, offsetX: number, offsetY: number) => void;
    onCreateAt: (date: Dated) => void;
  }
  let { notes, timelineId, selectedId, showLinks, markerSets, flashId, onOpenFull, onSelect, onMove, onCreateAt }: Props = $props();

  const MIN_PX = 1e-9; // ~a trillion years across the screen: past the Big Bang, effectively unbounded
  const MAX_PX = 60000; // a few hours per card width

  let width = $state(0);
  let height = $state(0);
  let view = $state({ center: new Date().getFullYear(), pxPerYear: 6, panY: 0 });
  let stage: HTMLDivElement;

  const axisY = $derived(Math.round(height / 2 + view.panY));
  const xOf = (t: number) => width / 2 + (t - view.center) * view.pxPerYear;

  // ------------------------------------------------------------ view memory
  // Each timeline remembers where you left it (per device; a convenience only).
  const viewKey = (id: string) => `view:${id}`;
  $effect(() => {
    const id = timelineId;
    untrack(() => {
      try {
        const saved = JSON.parse(localStorage.getItem(viewKey(id)) ?? "null");
        if (saved && Number.isFinite(saved.center)) return void (view = saved);
      } catch {}
      fitWhenReady = true;
    });
  });
  let fitWhenReady = $state(false);
  $effect(() => {
    // Wait for the notes too, so a fresh timeline opens framed around them.
    if (fitWhenReady && width > 0 && notes.length) {
      fitWhenReady = false;
      untrack(fit);
    }
  });
  $effect(() => {
    const v = JSON.stringify(view);
    const id = untrack(() => timelineId);
    const timer = setTimeout(() => {
      try { localStorage.setItem(viewKey(id), v); } catch {}
    }, 300);
    return () => clearTimeout(timer);
  });

  export function fit() {
    if (!notes.length || width === 0) {
      view = { center: new Date().getFullYear(), pxPerYear: 6, panY: 0 };
      return;
    }
    const ts = notes.map(axisValue);
    const [lo, hi] = [Math.min(...ts), Math.max(...ts)];
    const span = Math.max(hi - lo, 4);
    view = {
      center: (lo + hi) / 2,
      pxPerYear: clamp((width - CARD_W * 1.6) / span, MIN_PX, MAX_PX),
      panY: 0,
    };
  }

  export function zoom(factor: number, px = width / 2) {
    const t = view.center + (px - width / 2) / view.pxPerYear;
    const p = clamp(view.pxPerYear * factor, MIN_PX, MAX_PX);
    view = { ...view, pxPerYear: p, center: t - (px - width / 2) / p };
  }

  /** The date in the middle of the view, for new notes. */
  export const centerDate = (): Dated => dateAt(view.center, Math.min(view.pxPerYear, 100));

  /** Bring a note's card to the middle of the screen, left of `inset` px of panel. */
  export function focus(note: Note, inset = 0) {
    const p = placed.find((c) => c.id === note.id);
    view = {
      ...view,
      center: axisValue(note) + inset / 2 / view.pxPerYear,
      panY: p ? view.panY - (p.y + CARD_H / 2 - height / 2) : view.panY,
    };
  }

  // ----------------------------------------------------------------- layout
  let drag = $state<{ id: string; x: number; y: number } | null>(null);

  const placed: Placed[] = $derived(
    placeCards(
      notes.map((n) => {
        const anchorX = xOf(axisValue(n));
        if (drag?.id === n.id)
          return { id: n.id, anchorX, pinned: true, offsetX: drag.x - anchorX, offsetY: drag.y - axisY };
        return { id: n.id, anchorX, pinned: n.pinned, offsetX: n.offsetX, offsetY: n.offsetY };
      }),
      axisY,
    ),
  );

  const margin = CARD_W;
  const visible = $derived(
    placed.filter(
      (c) =>
        (c.x + CARD_W > -margin && c.x < width + margin && c.y + CARD_H > -margin && c.y < height + margin) ||
        (c.anchorX > -margin && c.anchorX < width + margin),
    ),
  );
  const stems = $derived(routeStems(visible, axisY));
  const byId = $derived(new Map(notes.map((n) => [n.id, n])));
  const tickList = $derived(width ? ticks(view.center - width / 2 / view.pxPerYear, view.center + width / 2 / view.pxPerYear, view.pxPerYear) : []);

  // ------------------------------------------------------------------ links
  let hoverId = $state<string | null>(null);
  const linkPairs = $derived.by(() => {
    const byTitle = new Map(notes.map((n) => [titleKey(n.title), n.id]));
    const focusId = hoverId ?? selectedId;
    const pos = new Map(visible.map((c) => [c.id, c]));
    const out: { d: string; strong: boolean }[] = [];
    for (const n of notes) {
      for (const title of linksIn(n.body)) {
        const target = byTitle.get(titleKey(title));
        if (!target || target === n.id) continue;
        const strong = focusId === n.id || focusId === target;
        if (!showLinks && !strong) continue;
        const [a, b] = [pos.get(n.id), pos.get(target)];
        if (!a || !b) continue;
        const [ax, ay, bx, by] = [a.x + CARD_W / 2, a.y + CARD_H / 2, b.x + CARD_W / 2, b.y + CARD_H / 2];
        const bend = Math.min(160, Math.abs(bx - ax) / 2 + 40);
        out.push({ d: `M${ax} ${ay} C${ax} ${ay - bend} ${bx} ${by - bend} ${bx} ${by}`, strong });
      }
    }
    return out;
  });
  const linkCount = $derived.by(() => {
    const byTitle = new Set(notes.map((n) => titleKey(n.title)));
    const count = new Map<string, number>();
    for (const n of notes) count.set(n.id, linksIn(n.body).filter((t) => byTitle.has(titleKey(t))).length);
    return count;
  });

  // ------------------------------------------------------------ interaction
  let pan = $state<{ x: number; y: number } | null>(null);
  let press: { id: string; px: number; py: number; cx: number; cy: number; moved: boolean } | null = null;

  // Pointer capture makes the browser report a card's double-click on the stage,
  // so card double-clicks are detected here and the stage's dblclick ignores them.
  let downOnCard = false;
  let lastCardClick: { id: string; t: number } | null = null;

  function onStageDown(e: PointerEvent) {
    if (e.button !== 0) return;
    downOnCard = false;
    pan = { x: e.clientX, y: e.clientY };
    stage.setPointerCapture(e.pointerId);
  }

  function onCardDown(e: PointerEvent, c: Placed) {
    if (e.button !== 0) return;
    e.stopPropagation();
    downOnCard = true;
    press = { id: c.id, px: e.clientX, py: e.clientY, cx: c.x, cy: c.y, moved: false };
    stage.setPointerCapture(e.pointerId);
  }

  function onMoveEvt(e: PointerEvent) {
    if (press) {
      const [dx, dy] = [e.clientX - press.px, e.clientY - press.py];
      if (!press.moved && Math.hypot(dx, dy) < 4) return;
      press.moved = true;
      drag = { id: press.id, x: press.cx + dx, y: press.cy + dy };
    } else if (pan) {
      view = {
        ...view,
        center: view.center - (e.clientX - pan.x) / view.pxPerYear,
        panY: view.panY + (e.clientY - pan.y),
      };
      pan = { x: e.clientX, y: e.clientY };
    }
  }

  function onUp() {
    if (press) {
      const note = byId.get(press.id);
      if (press.moved && drag && note) {
        const anchorX = xOf(axisValue(note));
        onMove(note, true, Math.round(drag.x - anchorX), Math.round(drag.y - axisY));
      } else if (!press.moved) {
        const now = performance.now();
        if (lastCardClick?.id === press.id && now - lastCardClick.t < 400) {
          lastCardClick = null;
          onOpenFull(press.id);
        } else {
          lastCardClick = { id: press.id, t: now };
          onSelect(press.id);
        }
      }
    }
    press = null;
    drag = null;
    pan = null;
  }

  /** The wheel only zooms, around the cursor; panning is left-drag on empty space. */
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    // Line-mode wheels (Firefox/GTK) report ~3 per notch; pixel-mode ~100.
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    // Trackpad pinch arrives as ctrl+wheel with small deltas, so it gets a stronger rate.
    const rate = e.ctrlKey || e.metaKey ? 0.01 : 0.0015;
    zoom(Math.exp(-dy * rate), e.clientX - rect.left);
  }

  // Safari/WKWebView reports pinch as gesture events rather than ctrl+wheel.
  let gestureBase = 0;
  function onGesture(e: Event & { scale?: number; clientX?: number }) {
    e.preventDefault();
    if (e.type === "gesturestart") gestureBase = view.pxPerYear;
    else if (gestureBase) {
      const rect = stage.getBoundingClientRect();
      zoom((gestureBase * (e.scale ?? 1)) / view.pxPerYear, (e.clientX ?? rect.left + width / 2) - rect.left);
    }
  }

  function onDouble(e: MouseEvent) {
    if (downOnCard) return;
    const rect = stage.getBoundingClientRect();
    const t = view.center + (e.clientX - rect.left - width / 2) / view.pxPerYear;
    onCreateAt(dateAt(t, view.pxPerYear));
  }

  function unpin(e: MouseEvent, note: Note) {
    e.stopPropagation();
    onMove(note, false, 0, 0);
  }

  $effect(() => {
    const opts = { passive: false } as AddEventListenerOptions;
    stage.addEventListener("wheel", onWheel, opts);
    for (const g of ["gesturestart", "gesturechange"]) stage.addEventListener(g, onGesture as EventListener, opts);
    return () => {
      stage.removeEventListener("wheel", onWheel);
      for (const g of ["gesturestart", "gesturechange"]) stage.removeEventListener(g, onGesture as EventListener);
    };
  });

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const eraX = $derived(xOf(0));

  // ------------------------------------------------------- reference markers
  const STRIP_TOP = 76;
  const LANE_H = 22;
  /** Each enabled set gets its own strip; overlapping spans within a set stack.
   *  A marker already shown by an earlier set (e.g. the Triassic in both Geologic
   *  time and Dinosaurs) is drawn once. */
  const lanes = $derived.by(() => {
    const out: { m: Marker; lane: number }[] = [];
    const seen = new Set<string>();
    let base = 0;
    for (const set of markerSets) {
      const ends: number[] = [];
      for (const m of [...set.markers].sort((a, b) => a.start - b.start)) {
        const key = `${m.name}|${m.start}|${m.end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let lane = ends.findIndex((e) => e <= m.start);
        if (lane < 0) lane = ends.push(-Infinity) - 1;
        ends[lane] = m.end ?? m.start;
        out.push({ m, lane: base + lane });
      }
      base += ends.length;
    }
    return { out, count: base };
  });
  const stripBottom = $derived(lanes.count ? STRIP_TOP + lanes.count * LANE_H : 0);

  // Rough label width, to drop labels that would not fit.
  const labelW = (t: string) => t.length * 6.2 + 14;

  const markerShapes = $derived.by(() => {
    type Shape = { x0: number; x1: number; y: number; m: Marker; i: number; label: string; also: string[] };
    const shapes: Shape[] = [];
    lanes.out.forEach(({ m, lane }, i) => {
      const x0 = xOf(m.start);
      const x1 = m.end == null ? x0 : xOf(m.end);
      if (x1 < -400 || x0 > width + 400) return;
      shapes.push({ x0, x1, y: STRIP_TOP + lane * LANE_H, m, i, label: m.name, also: [] });
    });
    // Events too close to label separately: the first keeps its label, the rest
    // are counted ("+2") and listed in its tooltip.
    const lastLabel = new Map<number, Shape>();
    for (const sh of shapes.filter((s) => s.m.end == null).sort((a, b) => a.x0 - b.x0)) {
      const prev = lastLabel.get(sh.y);
      if (prev && sh.x0 < prev.x0 + labelW(prev.label) + 10) {
        prev.also.push(sh.m.name);
        prev.label = `${prev.m.name} +${prev.also.length}`;
        sh.label = "";
      } else lastLabel.set(sh.y, sh);
    }
    return shapes;
  });
  const tip = (sh: { m: Marker; also: string[] }) =>
    [sh.m.name + (sh.m.note ? ` (${sh.m.note})` : ""), ...sh.also].join("\n");
</script>

<div
  class="stage"
  class:panning={!!pan}
  bind:this={stage}
  bind:clientWidth={width}
  bind:clientHeight={height}
  onpointerdown={onStageDown}
  onpointermove={onMoveEvt}
  onpointerup={onUp}
  onpointercancel={onUp}
  ondblclick={onDouble}
  role="application"
  aria-label="Timeline"
>
  <svg class="lines" {width} {height} aria-hidden="true">
    <defs>
      <linearGradient id="axis-fade" x1="0" x2="1">
        <stop offset="0" stop-color="var(--axis)" stop-opacity="0" />
        <stop offset="0.08" stop-color="var(--axis)" />
        <stop offset="0.92" stop-color="var(--axis)" />
        <stop offset="1" stop-color="var(--axis)" stop-opacity="0" />
      </linearGradient>
    </defs>

    {#if eraX > 0 && eraX < width}
      <line class="era" x1={eraX} x2={eraX} y1="0" y2={height} />
      <text class="era-label" x={eraX - 10} y="64" text-anchor="end">BCE</text>
      <text class="era-label" x={eraX + 10} y="64">AD</text>
    {/if}

    {#each markerShapes as sh (sh.i)}
      {#if sh.m.end == null}
        <line class="marker-line" x1={sh.x0} x2={sh.x0} y1={stripBottom} y2={height} />
      {:else}
        <line class="marker-edge" x1={sh.x0} x2={sh.x0} y1={stripBottom} y2={height} />
        <line class="marker-edge" x1={sh.x1} x2={sh.x1} y1={stripBottom} y2={height} />
      {/if}
    {/each}

    {#each tickList as tk (tk.t)}
      {@const tx = xOf(tk.t)}
      <line class="tick" class:minor={!tk.major} x1={tx} x2={tx} y1={axisY - (tk.major ? 5 : 3)} y2={axisY + (tk.major ? 5 : 3)} />
      {#if tk.label}
        <text class="tick-label" class:minor={!tk.major} x={tx} y={axisY + 20} text-anchor="middle">{tk.label}</text>
      {/if}
    {/each}

    <rect x="0" y={axisY - 0.75} {width} height="1.5" fill="url(#axis-fade)" />

    {#each linkPairs as l}
      <path class="link" class:strong={l.strong} d={l.d} />
    {/each}

    {#each stems as s (s.id)}
      <path class="stem" class:active={s.id === selectedId || s.id === hoverId} d={s.path} />
    {/each}
    {#each stems as s (s.id)}
      <circle class="anchor" class:active={s.id === selectedId || s.id === hoverId} cx={s.anchorX} cy={axisY} r="3" />
    {/each}
  </svg>

  {#each visible as c (c.id)}
    {@const n = byId.get(c.id)!}
    {@const links = linkCount.get(c.id) ?? 0}
    <div
      class="card glass-strong"
      class:selected={c.id === selectedId}
      class:dragging={drag?.id === c.id}
      class:flash={c.id === flashId}
      style:transform="translate({c.x}px, {c.y}px)"
      style:width="{CARD_W}px"
      style:height="{CARD_H}px"
      onpointerdown={(e) => onCardDown(e, c)}
      onpointerenter={() => (hoverId = c.id)}
      onpointerleave={() => (hoverId = null)}
      onkeydown={(e) => e.key === "Enter" && onSelect(c.id)}
      role="button"
      tabindex="0"
    >
      <div class="card-date">{formatDate(n)}</div>
      <div class="card-title">{n.title}</div>
      <div class="card-meta">
        <span class="card-author">{n.author}</span>
        {#if links}<span class="badge" title="{links} link{links === 1 ? '' : 's'}">↗ {links}</span>{/if}
        {#if n.pinned}
          <button class="pin" title="Unpin (return to automatic placement)" onpointerdown={(e) => e.stopPropagation()} onclick={(e) => unpin(e, n)}>
            <Pin size={12} />
          </button>
        {/if}
      </div>
    </div>
  {/each}

  {#if stripBottom}
    <!-- Era ruler: sits above the cards, which slide underneath it. -->
    <svg class="strips" {width} height={stripBottom + 6} aria-label="Reference eras">
      <rect class="plate" x="0" y={STRIP_TOP - 6} {width} height={stripBottom - STRIP_TOP + 10} />
      {#each markerShapes as sh (sh.i)}
        {#if sh.m.end == null}
          <g class="marker" transform="translate({sh.x0} {sh.y + 9})">
            <title>{tip(sh)}</title>
            <line class="marker-line" x1="0" x2="0" y1="-9" y2="13" />
            <rect x="-3.5" y="-3.5" width="7" height="7" transform="rotate(45)" />
          </g>
        {:else}
          {@const l = Math.max(sh.x0, 0)}
          {@const r = Math.min(sh.x1, width)}
          <g class="marker band" class:alt={sh.i % 2 === 1}>
            <title>{tip(sh)}</title>
            <rect x={sh.x0} y={sh.y} width={Math.max(sh.x1 - sh.x0, 1)} height="18" rx="4" />
            {#if r - l > labelW(sh.m.name)}
              <text x={(l + r) / 2} y={sh.y + 12.5} text-anchor="middle">{sh.m.name}</text>
            {/if}
          </g>
        {/if}
      {/each}
      <!-- Event labels last, haloed, so later markers never draw over them. -->
      {#each markerShapes as sh (sh.i)}
        {#if sh.m.end == null && sh.label}
          <text class="ev-label" x={sh.x0 + 9} y={sh.y + 12.5}><title>{tip(sh)}</title>{sh.label}</text>
        {/if}
      {/each}
    </svg>
  {/if}
</div>

<style>
  .stage {
    position: absolute;
    inset: 0;
    overflow: hidden;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  .stage.panning {
    cursor: grabbing;
  }
  .lines {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .tick {
    stroke: var(--axis);
    stroke-width: 1.2;
  }
  .tick.minor {
    stroke-width: 0.8;
    opacity: 0.6;
  }
  .tick-label {
    fill: var(--text-3);
    font: 500 10.5px var(--font-ui);
    letter-spacing: 0.04em;
    font-variant-numeric: tabular-nums;
  }
  .tick-label.minor {
    font-size: 9.5px;
    opacity: 0.8;
  }
  .era {
    stroke: var(--accent);
    stroke-opacity: 0.25;
    stroke-dasharray: 2 6;
  }
  .era-label {
    fill: var(--accent);
    opacity: 0.55;
    font: 600 10px var(--font-ui);
    letter-spacing: 0.18em;
  }
  .strips {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 6;
    pointer-events: none;
  }
  .plate {
    fill: var(--bg);
    stroke: var(--hairline);
    stroke-width: 1;
  }
  .marker {
    pointer-events: auto;
  }
  .marker text {
    fill: var(--text-2);
    font: 500 10.5px var(--font-ui);
    letter-spacing: 0.02em;
  }
  .ev-label {
    pointer-events: auto;
    fill: var(--text-2);
    font: 500 10.5px var(--font-ui);
    letter-spacing: 0.02em;
    paint-order: stroke;
    stroke: var(--bg);
    stroke-width: 4px;
    stroke-linejoin: round;
  }
  .marker.band rect {
    fill: color-mix(in srgb, var(--text) 7%, transparent);
    stroke: var(--hairline);
  }
  .marker.band.alt rect {
    fill: color-mix(in srgb, var(--text) 4%, transparent);
  }
  .marker > rect {
    fill: var(--text-2);
  }
  .marker-line {
    stroke: var(--text-3);
    stroke-opacity: 0.45;
  }
  .marker-edge {
    stroke: var(--text-3);
    stroke-opacity: 0.22;
    stroke-dasharray: 2 5;
  }
  .stem {
    fill: none;
    stroke: var(--stem);
    stroke-width: 1.25;
    stroke-linejoin: miter;
    transition: stroke 0.15s;
  }
  .stem.active {
    stroke: var(--accent);
    stroke-width: 1.5;
  }
  .anchor {
    fill: var(--bg);
    stroke: var(--stem);
    stroke-width: 1.5;
  }
  .anchor.active {
    fill: var(--accent);
    stroke: var(--accent);
  }
  .link {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.2;
    stroke-dasharray: 3 4;
    opacity: 0.28;
  }
  .link.strong {
    opacity: 0.85;
    stroke-width: 1.6;
  }

  .card {
    position: absolute;
    left: 0;
    top: 0;
    padding: 11px 14px 10px;
    border-radius: 14px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    cursor: pointer;
    transition: box-shadow 0.18s, border-color 0.18s, background 0.18s;
    will-change: transform;
  }
  .card {
    box-shadow: var(--shadow);
  }
  .card:hover {
    box-shadow: var(--shadow-lift);
  }
  .card.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 0.5px var(--accent), var(--shadow-lift);
  }
  .card.flash {
    animation: flash 1.4s ease-out;
  }
  @keyframes flash {
    0%,
    40% {
      border-color: var(--accent);
      box-shadow: 0 0 0 4px var(--accent-soft), var(--shadow-lift);
    }
  }
  .card.dragging {
    cursor: grabbing;
    box-shadow: var(--shadow-lift);
    z-index: 5;
    opacity: 0.95;
  }
  .card:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .card-date {
    font: 600 10.5px var(--font-ui);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .card-title {
    font: 560 15px/1.25 var(--font-serif);
    color: var(--text);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .card-meta {
    margin-top: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--text-2);
    min-width: 0;
  }
  .card-author {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    font-size: 10.5px;
    color: var(--text-3);
  }
  .pin {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 6px;
    color: var(--accent);
  }
  .pin:hover {
    background: var(--accent-soft);
  }
</style>
