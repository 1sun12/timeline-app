<script lang="ts">
  import { Plus, Settings, CalendarDays, RefreshCw, Search, Trash2, Pencil, Crown, Check } from "@lucide/svelte";
  import { MASTER_ID, type Note, type Timeline } from "./api";
  import { axisValue, formatDate } from "./time";

  interface Props {
    timelines: Timeline[];
    currentId: string;
    notes: Note[];
    selectedId: string | null;
    sync: { state: "off" | "idle" | "syncing" | "error"; message: string };
    searchEl?: HTMLInputElement;
    onSelectTimeline: (id: string) => void;
    onCreateTimeline: (name: string) => void;
    onRenameTimeline: (t: Timeline, name: string) => void;
    onDeleteTimeline: (t: Timeline) => void;
    onOpenNote: (n: Note) => void;
    onSettings: () => void;
    onActivity: () => void;
    onSync: () => void;
  }
  let {
    timelines, currentId, notes, selectedId, sync, searchEl = $bindable(),
    onSelectTimeline, onCreateTimeline, onRenameTimeline, onDeleteTimeline, onOpenNote, onSettings, onActivity, onSync,
  }: Props = $props();

  let query = $state("");
  let adding = $state(false);
  let newName = $state("");
  let editing = $state<string | null>(null);
  let editName = $state("");

  const list = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return notes
      .filter((n) => !q || n.title.toLowerCase().includes(q) || n.author.toLowerCase().includes(q))
      .sort((a, b) => axisValue(a) - axisValue(b));
  });

  function submitNew() {
    if (newName.trim()) onCreateTimeline(newName.trim());
    adding = false;
    newName = "";
  }
  function submitRename(t: Timeline) {
    if (editName.trim() && editName.trim() !== t.name) onRenameTimeline(t, editName.trim());
    editing = null;
  }
  const autofocus = (el: HTMLElement) => el.focus();
</script>

<nav class="sidebar glass">
  <header data-tauri-drag-region>
    <div class="brand" data-tauri-drag-region>
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2 12h20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".55" />
        <path d="M7 12V5h6M16 12v6h5" stroke="currentColor" stroke-width="1.6" fill="none" opacity=".55" />
        <circle cx="7" cy="12" r="2.2" fill="var(--accent)" />
        <circle cx="16" cy="12" r="2.2" fill="var(--accent)" />
      </svg>
      <span data-tauri-drag-region>Timeline</span>
    </div>
  </header>

  <section>
    <div class="section-head">
      <span class="label">Timelines</span>
      <button class="icon-btn small" title="New timeline" onclick={() => (adding = true)}><Plus size={15} /></button>
    </div>
    <ul class="timelines">
      {#each timelines as t (t.id)}
        <li class:active={t.id === currentId}>
          {#if editing === t.id}
            <form onsubmit={(e) => (e.preventDefault(), submitRename(t))}>
              <input class="field slim" bind:value={editName} use:autofocus onblur={() => submitRename(t)} onkeydown={(e) => e.key === "Escape" && (editing = null)} />
            </form>
          {:else}
            <button class="tl" onclick={() => onSelectTimeline(t.id)} ondblclick={() => ((editing = t.id), (editName = t.name))}>
              {#if t.id === MASTER_ID}<Crown size={13} />{:else}<span class="dot"></span>{/if}
              <span class="name">{t.name}</span>
            </button>
            <span class="row-actions">
              <button class="icon-btn tiny" title="Rename" onclick={() => ((editing = t.id), (editName = t.name))}><Pencil size={12} /></button>
              {#if t.id !== MASTER_ID}
                <button class="icon-btn tiny" title="Delete timeline" onclick={() => onDeleteTimeline(t)}><Trash2 size={12} /></button>
              {/if}
            </span>
          {/if}
        </li>
      {/each}
      {#if adding}
        <li>
          <form onsubmit={(e) => (e.preventDefault(), submitNew())}>
            <input class="field slim" placeholder="Name, e.g. Research papers" bind:value={newName} use:autofocus onblur={submitNew} onkeydown={(e) => e.key === "Escape" && ((adding = false), (newName = ""))} />
          </form>
        </li>
      {/if}
    </ul>
  </section>

  <section class="notes">
    <div class="search">
      <Search size={14} />
      <input bind:this={searchEl} bind:value={query} placeholder="Search notes" spellcheck="false" />
    </div>
    <ul>
      {#each list as n (n.id)}
        <li>
          <button class="note" class:active={n.id === selectedId} onclick={() => onOpenNote(n)}>
            <span class="note-title">{n.title}</span>
            <span class="note-date">{formatDate(n)}{n.author ? ` · ${n.author}` : ""}</span>
          </button>
        </li>
      {:else}
        <li class="empty">{query ? "No matches" : "No notes yet"}</li>
      {/each}
    </ul>
  </section>

  <footer>
    <button class="foot-btn" onclick={onActivity} title="Activity"><CalendarDays size={16} /><span>Activity</span></button>
    <button
      class="foot-btn sync {sync.state}"
      onclick={onSync}
      title={sync.message || (sync.state === "off" ? "Set up sync" : "Sync now")}
    >
      <span class="spin" class:on={sync.state === "syncing"}><RefreshCw size={16} /></span>
      <span>{sync.state === "off" ? "Sync" : sync.state === "error" ? "Sync failed" : sync.state === "syncing" ? "Syncing" : "Synced"}</span>
      {#if sync.state === "idle"}<Check size={12} />{/if}
    </button>
    <button class="icon-btn" onclick={onSettings} title="Settings (⌘,)"><Settings size={16} /></button>
  </footer>
</nav>

<style>
  .sidebar {
    position: relative;
    z-index: 10;
    height: 100%;
    display: flex;
    flex-direction: column;
    border-width: 0 1px 0 0;
    border-radius: 0;
    box-shadow: none;
  }
  header {
    height: 52px;
    flex: none;
    display: flex;
    align-items: center;
    padding: 0 16px;
  }
  :global(html.mac) header {
    padding-left: 84px; /* clear the traffic lights */
    height: 52px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font: 600 17px var(--font-serif);
    letter-spacing: 0.01em;
  }
  section {
    padding: 8px 10px;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 6px 4px;
  }
  .icon-btn.small {
    width: 24px;
    height: 24px;
  }
  .icon-btn.tiny {
    width: 22px;
    height: 22px;
    border-radius: 6px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .timelines li {
    position: relative;
    display: flex;
    align-items: center;
    border-radius: 9px;
  }
  .timelines li:hover {
    background: var(--accent-soft);
  }
  .timelines li.active {
    background: var(--glass-strong);
    box-shadow: var(--shadow);
  }
  .timelines form {
    flex: 1;
    padding: 2px;
  }
  .field.slim {
    height: 30px;
  }
  .tl {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 9px;
    height: 32px;
    padding: 0 10px;
    color: var(--text-2);
    text-align: left;
  }
  li.active .tl {
    color: var(--text);
    font-weight: 550;
  }
  li.active .tl :global(svg),
  li.active .dot {
    color: var(--accent);
    background-color: var(--accent);
  }
  .tl :global(svg) {
    background: none !important;
    flex: none;
  }
  .dot {
    width: 7px;
    height: 7px;
    margin: 0 3px;
    border-radius: 50%;
    background: var(--text-3);
    flex: none;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-actions {
    display: none;
    padding-right: 4px;
  }
  .timelines li:hover .row-actions {
    display: flex;
  }
  .notes {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--hairline);
    margin-top: 6px;
    padding-top: 12px;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 32px;
    padding: 0 10px;
    border-radius: 9px;
    background: var(--field);
    border: 1px solid var(--hairline);
    color: var(--text-3);
    margin-bottom: 8px;
  }
  .search:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    outline: none;
  }
  .notes ul {
    overflow-y: auto;
    flex: 1;
    margin: 0 -4px;
    padding: 0 4px;
  }
  .note {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 6px 10px;
    border-radius: 9px;
    text-align: left;
  }
  .note:hover {
    background: var(--accent-soft);
  }
  .note.active {
    background: var(--glass-strong);
    box-shadow: var(--shadow);
  }
  .note-title {
    font: 500 14px/1.3 var(--font-serif);
    color: var(--text);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note-date {
    font-size: 11.5px;
    color: var(--text-3);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    padding: 8px 10px;
    color: var(--text-3);
    font-style: italic;
  }
  footer {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 10px;
    border-top: 1px solid var(--hairline);
  }
  .foot-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 9px;
    border-radius: 8px;
    font-size: 12.5px;
    color: var(--text-2);
  }
  .foot-btn:hover {
    background: var(--accent-soft);
    color: var(--text);
  }
  .sync {
    margin-right: auto;
  }
  .sync.idle :global(svg:last-child) {
    color: var(--accent);
  }
  .sync.error {
    color: #c4552e;
  }
  .spin {
    display: grid;
  }
  .spin.on {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
