<script lang="ts">
  import { X, Flame, Trophy, CalendarCheck, FilePlus } from "@lucide/svelte";
  import type { Note, Timeline } from "./api";
  import { formatDate, MONTHS } from "./time";

  interface Props {
    notes: Note[];
    timelines: Timeline[];
    onOpen: (n: Note) => void;
    onClose: () => void;
  }
  let { notes, timelines, onOpen, onClose }: Props = $props();

  const pad = (n: number) => String(n).padStart(2, "0");
  const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  const today = new Date();
  const todayKey = key(today);

  /** Notes added per local calendar day. */
  const byDay = $derived.by(() => {
    const m = new Map<string, Note[]>();
    for (const n of notes) {
      if (!n.createdAt) continue;
      const k = key(new Date(n.createdAt));
      m.set(k, [...(m.get(k) ?? []), n]);
    }
    return m;
  });

  // 53 week columns ending with the current week, weeks starting on Sunday.
  const start = addDays(today, -(52 * 7 + today.getDay()));
  const weeks = $derived(
    Array.from({ length: 53 }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => {
        const date = addDays(start, w * 7 + d);
        const k = key(date);
        return { date, k, count: byDay.get(k)?.length ?? 0, future: date > today };
      }),
    ),
  );
  const monthLabels = $derived(
    weeks.map((w, i) => {
      const m = w[0].date.getMonth();
      return i === 0 || m !== weeks[i - 1][0].date.getMonth() ? MONTHS[m] : "";
    }),
  );

  const level = (c: number) => (c === 0 ? 0 : c === 1 ? 1 : c <= 3 ? 2 : c <= 6 ? 3 : 4);

  const stats = $derived.by(() => {
    const yearAgo = key(addDays(today, -365));
    let total = 0;
    let active = 0;
    for (const [k, ns] of byDay) if (k > yearAgo) (total += ns.length), active++;
    // Current streak: consecutive days up to today (or up to yesterday, if
    // nothing has been added yet today — the streak isn't broken until tomorrow).
    let current = 0;
    let d = byDay.has(todayKey) ? today : addDays(today, -1);
    while (byDay.has(key(d))) (current++, (d = addDays(d, -1)));
    let longest = 0;
    let run = 0;
    let prev: Date | null = null;
    for (const k of [...byDay.keys()].sort()) {
      const [y, m, dd] = k.split("-").map(Number);
      const date = new Date(y, m - 1, dd);
      run = prev && key(addDays(prev, 1)) === k ? run + 1 : 1;
      longest = Math.max(longest, run);
      prev = date;
    }
    return { total, active, current, longest };
  });

  let picked = $state(todayKey);
  const pickedNotes = $derived(byDay.get(picked) ?? []);
  const timelineName = (id: string) => timelines.find((t) => t.id === id)?.name ?? "";
  const pretty = (k: string) => {
    const [y, m, d] = k.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  };
</script>

<div class="scrim" onclick={onClose} aria-hidden="true"></div>
<div class="modal glass-strong" role="dialog" aria-label="Activity">
  <header>
    <div>
      <h2>Activity</h2>
      <p>Every day you added something, across all timelines.</p>
    </div>
    <button class="icon-btn" onclick={onClose} title="Close (Esc)"><X size={17} /></button>
  </header>

  <div class="stats">
    <div class="stat"><FilePlus size={15} /><b>{stats.total}</b><span>notes this year</span></div>
    <div class="stat"><CalendarCheck size={15} /><b>{stats.active}</b><span>active days</span></div>
    <div class="stat"><Flame size={15} /><b>{stats.current}</b><span>day streak</span></div>
    <div class="stat"><Trophy size={15} /><b>{stats.longest}</b><span>longest streak</span></div>
  </div>

  <div class="heat">
    <div class="days">
      <span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span>
    </div>
    <div class="grid-wrap">
      <div class="months">
        {#each monthLabels as m}<span>{m}</span>{/each}
      </div>
      <div class="grid">
        {#each weeks as week}
          <div class="week">
            {#each week as day (day.k)}
              <button
                class="cell l{level(day.count)}"
                class:future={day.future}
                class:picked={day.k === picked}
                class:today={day.k === todayKey}
                disabled={day.future}
                title="{day.count} note{day.count === 1 ? '' : 's'} on {pretty(day.k)}"
                onclick={() => (picked = day.k)}
              ></button>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  </div>
  <div class="legend">
    Less {#each [0, 1, 2, 3, 4] as l}<span class="cell l{l}"></span>{/each} More
  </div>

  <div class="day">
    <h3>{pretty(picked)}</h3>
    {#if pickedNotes.length}
      <ul>
        {#each pickedNotes as n (n.id)}
          <li>
            <button onclick={() => onOpen(n)}>
              <span class="t">{n.title}</span>
              <span class="m">{formatDate(n)}{n.author ? ` · ${n.author}` : ""}</span>
              <span class="tl">{timelineName(n.timelineId)}</span>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="none">Nothing added this day.</p>
    {/if}
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(20, 14, 4, 0.18);
    z-index: 40;
    animation: fade 0.2s;
  }
  .modal {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: min(968px, calc(100vw - 48px));
    max-height: calc(100vh - 64px);
    overflow: auto;
    border-radius: 20px;
    padding: 22px 26px 24px;
    z-index: 41;
    animation: pop 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes fade {
    from { opacity: 0; }
  }
  @keyframes pop {
    from { opacity: 0; transform: translate(-50%, -48%) scale(0.98); }
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  h2 {
    font: 600 24px var(--font-serif);
    margin: 0;
  }
  header p {
    margin: 2px 0 0;
    color: var(--text-2);
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin: 18px 0 20px;
  }
  .stat {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    column-gap: 8px;
    padding: 12px 14px;
    border-radius: 12px;
    background: var(--field);
    border: 1px solid var(--hairline);
    color: var(--accent);
  }
  .stat b {
    font: 600 22px var(--font-serif);
    color: var(--text);
  }
  .stat span {
    grid-column: 1 / -1;
    font-size: 11.5px;
    color: var(--text-2);
  }
  .heat {
    display: flex;
    gap: 6px;
    overflow-x: auto;
  }
  .days {
    display: grid;
    grid-template-rows: 16px repeat(7, 13px);
    row-gap: 3px;
    font-size: 10px;
    color: var(--text-3);
  }
  .days span:first-child {
    height: 16px;
  }
  .months {
    display: grid;
    grid-template-columns: repeat(53, 13px);
    column-gap: 3px;
    height: 16px;
    font-size: 10px;
    color: var(--text-3);
    white-space: nowrap;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(53, 13px);
    column-gap: 3px;
    margin-top: 3px;
  }
  .week {
    display: grid;
    grid-template-rows: repeat(7, 13px);
    row-gap: 3px;
  }
  .cell {
    width: 13px;
    height: 13px;
    border-radius: 3.5px;
    display: inline-block;
    border: 1px solid var(--hairline);
  }
  .l0 { background: var(--field); }
  .l1 { background: color-mix(in srgb, var(--accent) 28%, transparent); }
  .l2 { background: color-mix(in srgb, var(--accent) 50%, transparent); }
  .l3 { background: color-mix(in srgb, var(--accent) 75%, transparent); }
  .l4 { background: var(--accent); }
  .cell.future {
    visibility: hidden;
  }
  .cell.today {
    border-color: var(--text-2);
  }
  .cell.picked {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  button.cell:hover:not(:disabled) {
    outline: 2px solid var(--accent-soft);
    outline-offset: 1px;
  }
  .legend {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 3px;
    font-size: 11px;
    color: var(--text-3);
    margin-top: 8px;
  }
  .legend .cell {
    margin: 0 1px;
  }
  .day {
    margin-top: 16px;
    border-top: 1px solid var(--hairline);
    padding-top: 14px;
  }
  h3 {
    font: 600 15px var(--font-serif);
    margin: 0 0 8px;
  }
  .day ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
  }
  .day li button {
    width: 100%;
    display: grid;
    grid-template-columns: 1fr auto;
    text-align: left;
    padding: 8px 12px;
    border-radius: 10px;
  }
  .day li button:hover {
    background: var(--accent-soft);
  }
  .t {
    font: 500 14.5px var(--font-serif);
  }
  .m {
    grid-row: 2;
    font-size: 12px;
    color: var(--text-2);
  }
  .tl {
    grid-row: 1 / span 2;
    grid-column: 2;
    align-self: center;
    font-size: 11.5px;
    padding: 2px 8px;
    border-radius: 6px;
    background: var(--field);
    color: var(--text-2);
  }
  .none {
    color: var(--text-3);
    font-style: italic;
    margin: 0;
  }
</style>
