<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { X, Trash2, Link2, Maximize2, Minimize2 } from "@lucide/svelte";
  import type { Note } from "./api";
  import Editor from "./Editor.svelte";
  import { render, linksIn, titleKey } from "./markdown";
  import { daysInMonth, formatDate, MAX_YEARS, MONTHS } from "./time";
  import { prefs } from "./prefs.svelte";

  interface Props {
    note: Note;
    notes: Note[];
    onSave: (note: Note) => Promise<Note>;
    onDelete: (note: Note) => void;
    onClose: () => void;
    onOpenLink: (title: string, from: Note) => void;
    onOpenUrl: (url: string) => void;
    fullscreen: boolean;
    onToggleFullscreen: () => void;
  }
  let { note, notes, onSave, onDelete, onClose, onOpenLink, onOpenUrl, fullscreen, onToggleFullscreen }: Props = $props();

  let draft = $state<Note>(untrack(() => ({ ...note })));
  let mode = $state<"write" | "preview">(untrack(() => (note.id && note.body ? "preview" : "write")));
  let status = $state<"" | "saving" | "saved" | "error">("");
  let error = $state("");
  let titleInput: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (!untrack(() => draft.id)) titleInput?.focus();
  });

  // ------------------------------------------------------------- date fields
  let yearAbs = $state(untrack(() => Math.abs(draft.year) || ""));
  let era = $state<"AD" | "BCE">(untrack(() => (draft.year < 0 ? "BCE" : "AD")));
  const time = $derived(
    draft.hour == null ? "" : `${String(draft.hour).padStart(2, "0")}:${String(draft.minute ?? 0).padStart(2, "0")}`,
  );

  function setYear() {
    const n = Math.floor(Number(yearAbs));
    draft.year = n > 0 ? (era === "BCE" ? -n : n) : 0;
    clampDay();
    changed();
  }
  function setMonth(v: string) {
    draft.month = v ? Number(v) : null;
    if (!draft.month) draft.day = null;
    clampDay();
    changed();
  }
  function setDay(v: string) {
    const d = Math.floor(Number(v));
    draft.day = v === "" || !d ? null : d;
    clampDay();
    changed();
  }
  function clampDay() {
    if (draft.day && draft.month && draft.year) draft.day = Math.min(draft.day, daysInMonth(draft.year, draft.month));
  }
  function setTime(v: string) {
    const [h, m] = v.split(":").map(Number);
    draft.hour = v ? h : null;
    draft.minute = v ? m : null;
    changed();
  }

  // ---------------------------------------------------------------- saving
  let timer: ReturnType<typeof setTimeout> | undefined;

  function problem(): string {
    if (!draft.title.trim()) return "Give it a title to save it";
    if (!draft.year) return "A year is required (estimate if you're unsure)";
    if (Math.abs(draft.year) > MAX_YEARS) return "Years are limited to a trillion either way";
    return "";
  }

  function changed() {
    clearTimeout(timer);
    error = problem();
    if (error) return void (status = "");
    status = "saving";
    timer = setTimeout(save, 450);
  }

  async function save() {
    timer = undefined;
    if (problem()) return;
    try {
      const saved = await onSave($state.snapshot(draft));
      draft.id = saved.id;
      draft.createdAt = saved.createdAt;
      draft.modifiedAt = saved.modifiedAt;
      status = "saved";
    } catch (e) {
      status = "error";
      error = String(e);
    }
  }

  // Flush a pending save if the panel closes mid-debounce.
  onDestroy(() => {
    if (timer) {
      clearTimeout(timer);
      void save();
    }
  });

  // ----------------------------------------------------------------- links
  const titles = $derived(new Set(notes.map((n) => titleKey(n.title))));
  const html = $derived(mode === "preview" ? render(draft.body, (t) => titles.has(titleKey(t))) : "");
  const backlinks = $derived(
    draft.title.trim()
      ? notes.filter((n) => n.id !== draft.id && linksIn(n.body).some((t) => titleKey(t) === titleKey(draft.title)))
      : [],
  );

  function onPreviewClick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    if (a.dataset.note) onOpenLink(a.dataset.note, $state.snapshot(draft));
    else if (/^https?:/.test(a.getAttribute("href") ?? "")) onOpenUrl(a.href);
  }
</script>

<aside class="panel glass-strong" class:full={fullscreen} aria-label={fullscreen ? "Document" : "Note"}>
  <header data-tauri-drag-region>
    <div class="status">
      {#if error}<span class="err">{error}</span>
      {:else if status === "saving"}Saving…
      {:else if status === "saved"}Saved
      {:else if draft.id}{formatDate(draft)}{/if}
    </div>
    {#if draft.id}
      <button class="icon-btn" title="Delete note" onclick={() => onDelete(draft)}><Trash2 size={16} /></button>
    {/if}
    <button
      class="icon-btn"
      title={fullscreen ? "Back to the timeline (Esc)" : "Open as a full document (Ctrl+Shift+F)"}
      onclick={onToggleFullscreen}
    >
      {#if fullscreen}<Minimize2 size={16} />{:else}<Maximize2 size={16} />{/if}
    </button>
    <button class="icon-btn" title="Close" onclick={onClose}><X size={17} /></button>
  </header>

  <input
    class="title"
    bind:this={titleInput}
    bind:value={draft.title}
    oninput={changed}
    placeholder="Title"
    spellcheck="false"
  />
  <input class="author" bind:value={draft.author} oninput={changed} placeholder="Author" spellcheck="false" />

  <div class="date">
    <div class="row">
      <label class="grow">
        <span class="label">Year</span>
        <input class="field" type="number" min="1" bind:value={yearAbs} oninput={setYear} placeholder="e.g. 380" />
      </label>
      <div>
        <span class="label">Era</span>
        <div class="segmented">
          {#each ["AD", "BCE"] as const as e}
            <button class:on={era === e} onclick={() => ((era = e), setYear())}>{e}</button>
          {/each}
        </div>
      </div>
    </div>
    <div class="row">
      <label class="grow">
        <span class="label">Month</span>
        <select class="field" value={draft.month ?? ""} onchange={(e) => setMonth(e.currentTarget.value)}>
          <option value="">—</option>
          {#each MONTHS as m, i}<option value={i + 1}>{m}</option>{/each}
        </select>
      </label>
      <label class="narrow">
        <span class="label">Day</span>
        <input
          class="field"
          type="number"
          min="1"
          max={draft.month && draft.year ? daysInMonth(draft.year, draft.month) : 31}
          disabled={!draft.month}
          value={draft.day ?? ""}
          oninput={(e) => setDay(e.currentTarget.value)}
          placeholder="—"
        />
      </label>
      <label class="grow">
        <span class="label">
          Time
          {#if draft.hour != null}
            <button class="clear" onclick={(e) => (e.preventDefault(), setTime(""))}>clear</button>
          {/if}
        </span>
        <input class="field" type="time" class:unset={draft.hour == null} value={time} oninput={(e) => setTime(e.currentTarget.value)} />
      </label>
    </div>
  </div>

  <div class="body-head">
    <div class="segmented">
      <button class:on={mode === "write"} onclick={() => (mode = "write")}>Write</button>
      <button class:on={mode === "preview"} onclick={() => (mode = "preview")}>Preview</button>
    </div>
    <span class="hint">Link notes with <code>[[Title]]</code>{prefs.vim ? " · Vim" : ""}</span>
  </div>

  <div class="body">
    {#if mode === "write"}
      <Editor value={draft.body} vimMode={prefs.vim} onChange={(v) => ((draft.body = v), changed())} />
    {:else}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="prose preview" onclick={onPreviewClick}>
        {#if draft.body.trim()}{@html html}{:else}<p class="empty">Nothing written yet.</p>{/if}
      </div>
    {/if}
  </div>

  {#if backlinks.length}
    <footer>
      <span class="label"><Link2 size={11} /> Linked from</span>
      <div class="backlinks">
        {#each backlinks as b (b.id)}
          <button onclick={() => onOpenLink(b.title, $state.snapshot(draft))}>{b.title}</button>
        {/each}
      </div>
    </footer>
  {/if}
</aside>

<style>
  .panel {
    position: absolute;
    top: 70px;
    right: 12px;
    bottom: 12px;
    width: min(460px, 42vw);
    border-radius: 18px;
    display: flex;
    flex-direction: column;
    padding: 10px 18px 14px;
    z-index: 20;
    animation: slide-in 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  /* Full document view: the whole window, a centred reading column. */
  .panel.full {
    position: fixed;
    inset: 0;
    width: auto;
    border-radius: 0;
    border: 0;
    background: var(--bg);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    box-shadow: none;
    z-index: 30;
    padding: 14px max(32px, calc((100vw - 860px) / 2)) 24px;
    animation: grow 0.2s ease-out;
  }
  :global(html.mac) .panel.full {
    padding-top: 34px; /* clear the traffic lights */
  }
  @keyframes grow {
    from {
      opacity: 0;
      transform: scale(0.985);
    }
  }
  .full .title {
    font-size: 38px;
    padding-top: 10px;
  }
  .full .author {
    font-size: 18px;
  }
  .full .date {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 10px;
  }
  .full .date .row {
    flex: 1;
    min-width: 300px;
  }
  .full .body {
    margin: 0 -18px;
  }
  .full :global(.prose) {
    font-size: 17px;
    line-height: 1.75;
  }
  .full :global(.cm-editor) {
    font-size: 15px;
  }
  @keyframes slide-in {
    from {
      transform: translateX(24px);
      opacity: 0;
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 2px;
    margin: 0 -8px 2px 0;
  }
  .status {
    flex: 1;
    font-size: 11.5px;
    color: var(--text-3);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .err {
    color: #c4552e;
  }
  .title {
    font: 600 26px/1.2 var(--font-serif);
    border: 0;
    background: none;
    outline: none;
    padding: 4px 0;
    width: 100%;
  }
  .author {
    font: italic 400 15px var(--font-serif);
    color: var(--text-2);
    border: 0;
    background: none;
    outline: none;
    padding: 2px 0 10px;
    width: 100%;
  }
  ::placeholder {
    color: var(--text-3);
    opacity: 0.8;
  }
  .date {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 0 14px;
    border-top: 1px solid var(--hairline);
    border-bottom: 1px solid var(--hairline);
  }
  .row {
    display: flex;
    gap: 10px;
    align-items: flex-end;
  }
  .row label,
  .row > div {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .narrow {
    width: 72px;
  }
  .clear {
    font: 500 10.5px var(--font-ui);
    color: var(--accent-ink);
    margin-left: 4px;
    text-transform: none;
    letter-spacing: 0;
  }
  .field.unset:not(:focus) {
    color: var(--text-3);
  }
  .field:disabled {
    opacity: 0.45;
  }
  .body-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 0 6px;
  }
  .hint {
    font-size: 11.5px;
    color: var(--text-3);
  }
  .hint code {
    font: 11px var(--font-mono);
  }
  .body {
    flex: 1;
    min-height: 0;
    margin: 0 -18px;
    overflow: auto;
  }
  .preview {
    padding: 10px 18px;
  }
  .empty {
    color: var(--text-3);
    font-style: italic;
  }
  footer {
    border-top: 1px solid var(--hairline);
    padding-top: 10px;
  }
  footer .label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .backlinks {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .backlinks button {
    font: 500 12.5px var(--font-serif);
    padding: 3px 9px;
    border-radius: 7px;
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
</style>
