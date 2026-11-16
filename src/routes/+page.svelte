<script lang="ts">
  import { onMount } from "svelte";
  import { Plus, Minus, Maximize2, Spline, Sun, Moon } from "@lucide/svelte";
  import { api, blankNote, isTauri, MASTER_ID, type Note, type SyncStatus, type Timeline } from "$lib/api";
  import { prefs, loadPrefs, setPref, isDark } from "$lib/prefs.svelte";
  import { titleKey } from "$lib/markdown";
  import { axisValue, type Dated } from "$lib/time";
  import TimelineView from "$lib/Timeline.svelte";
  import { MARKER_SETS } from "$lib/eras";
  import Sidebar from "$lib/Sidebar.svelte";
  import NoteEditor from "$lib/NoteEditor.svelte";
  import Settings from "$lib/Settings.svelte";
  import Activity from "$lib/Activity.svelte";
  import Welcome from "$lib/Welcome.svelte";

  let timelines = $state<Timeline[]>([]);
  let currentId = $state(MASTER_ID);
  let notes = $state<Note[]>([]);
  let editing = $state<Note | null>(null); // the note open in the editor (may be unsaved)
  let editorKey = $state(0);
  let fullscreen = $state(false); // the open note fills the window as a document
  let flashId = $state<string | null>(null);
  let modal = $state<"" | "settings" | "activity">("");
  let allNotes = $state<Note[]>([]);
  let syncStatus = $state<SyncStatus | null>(null);
  let sync = $state<{ state: "off" | "idle" | "syncing" | "error"; message: string }>({ state: "off", message: "" });
  let toast = $state<{ text: string; kind: "info" | "error" } | null>(null);
  let showLinks = $state(false);
  let timeline: TimelineView | undefined = $state();
  let searchEl: HTMLInputElement | undefined = $state();

  const current = $derived(timelines.find((t) => t.id === currentId));

  // --------------------------------------------------------------- theming
  $effect(() => {
    const root = document.documentElement;
    const dark = isDark();
    root.dataset.theme = dark ? "dark" : "light";
    root.style.setProperty("--accent", dark ? prefs.accentDark : prefs.accentLight);
  });

  function say(text: string, kind: "info" | "error" = "info") {
    toast = { text, kind };
    const mine = toast;
    setTimeout(() => toast === mine && (toast = null), kind === "error" ? 6000 : 3000);
  }

  // ------------------------------------------------------------------ data
  async function loadTimelines() {
    timelines = await api.listTimelines();
    // The current timeline was deleted (here or by sync): fall back to Master.
    if (!timelines.some((t) => t.id === currentId)) await selectTimeline(MASTER_ID);
  }
  async function loadNotes() {
    notes = await api.listNotes(currentId);
  }

  async function selectTimeline(id: string) {
    currentId = id;
    editing = null;
    try { localStorage.setItem("timeline", id); } catch {}
    await loadNotes();
  }

  async function createTimeline(name: string) {
    try {
      const t = await api.saveTimeline({ name });
      await loadTimelines();
      await selectTimeline(t.id);
    } catch (e) {
      say(String(e), "error");
    }
  }
  async function renameTimeline(t: Timeline, name: string) {
    await api.saveTimeline({ ...t, name });
    await loadTimelines();
  }
  async function deleteTimeline(t: Timeline) {
    if (!(await confirmDialog(`Delete “${t.name}” and all its notes? This can't be undone.`))) return;
    try {
      await api.deleteTimeline(t.id);
      await loadTimelines();
      say(`Deleted “${t.name}”`);
    } catch (e) {
      say(String(e), "error");
    }
  }

  function upsert(n: Note) {
    const i = notes.findIndex((x) => x.id === n.id);
    if (i < 0) notes.push(n);
    else notes[i] = n;
  }

  const panelInset = () => Math.min(460, innerWidth * 0.42) + 24;

  async function saveNote(n: Note): Promise<Note> {
    const before = notes.find((x) => x.id === n.id);
    const saved = await api.saveNote(n);
    // A new or re-dated note may now sit off-screen; follow it.
    if (!before || axisValue(before) !== axisValue(saved)) requestAnimationFrame(() => timeline?.focus(saved, panelInset()));
    // Keep the latest position from the timeline (a drag may have landed mid-edit).
    const existing = notes.find((x) => x.id === saved.id);
    upsert(existing ? { ...saved, pinned: existing.pinned, offsetX: existing.offsetX, offsetY: existing.offsetY } : saved);
    queueSync();
    return saved;
  }

  async function moveNote(n: Note, pinned: boolean, offsetX: number, offsetY: number) {
    const moved = { ...n, pinned, offsetX, offsetY };
    upsert(moved); // show it where it was dropped immediately
    try {
      upsert(await api.saveNote(moved));
      queueSync();
    } catch (e) {
      say(String(e), "error");
    }
  }

  async function deleteNote(n: Note) {
    if (!(await confirmDialog(`Delete “${n.title}”?`))) return;
    await api.deleteNote(n.id);
    notes = notes.filter((x) => x.id !== n.id);
    closeEditor();
    queueSync();
  }

  function openNote(n: Note, center = true) {
    if (n.timelineId !== currentId) {
      void selectTimeline(n.timelineId).then(() => openNote(n));
      return;
    }
    editing = { ...n };
    editorKey++;
    if (center) timeline?.focus(n, panelInset());
  }

  function newNote(partial: Partial<Note> = {}) {
    editing = blankNote(currentId, { year: timeline?.centerDate().year ?? new Date().getFullYear(), ...partial });
    editorKey++;
  }

  function createAt(d: Dated) {
    newNote({ year: d.year, month: d.month ?? null, day: d.day ?? null });
  }

  /**
   * Follow a [[link]]. In the full document view it opens the linked document;
   * from the side panel it only brings the linked card into view and highlights
   * it, leaving the panel on the current note. A link to a note that doesn't
   * exist yet creates it either way.
   */
  function openLink(title: string, from: Note) {
    const target = notes.find((n) => titleKey(n.title) === titleKey(title));
    if (!target) return newNote({ title, year: from.year });
    if (fullscreen) return openNote(target);
    timeline?.focus(target, panelInset());
    flashId = null;
    requestAnimationFrame(() => (flashId = target.id));
    setTimeout(() => flashId === target.id && (flashId = null), 1500);
  }

  function openFull(id: string) {
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    openNote(n, false);
    fullscreen = true;
  }

  function closeEditor() {
    editing = null;
    fullscreen = false;
  }

  async function openUrl(url: string) {
    if (isTauri) (await import("@tauri-apps/plugin-opener")).openUrl(url);
    else window.open(url, "_blank", "noopener");
  }

  async function confirmDialog(message: string) {
    if (!isTauri) return confirm(message);
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return ask(message, { title: "Timeline", kind: "warning" });
  }

  async function openActivity() {
    allNotes = await api.allNotes();
    modal = "activity";
  }

  // ------------------------------------------------------------ share files
  async function exportTimeline() {
    if (!current || !isTauri) return;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: `${current.name}.timeline.json`,
      filters: [{ name: "Timeline", extensions: ["json"] }],
    });
    if (!path) return;
    try {
      await api.exportTimeline(current.id, path);
      say(`Exported “${current.name}”`);
    } catch (e) {
      say(String(e), "error");
    }
  }

  async function importTimeline() {
    if (!isTauri) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, filters: [{ name: "Timeline", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    try {
      const t = await api.importTimeline(path);
      await loadTimelines();
      await selectTimeline(t.id);
      modal = "";
      say(`Imported “${t.name}”`);
    } catch (e) {
      say(String(e), "error");
    }
  }

  // ------------------------------------------------------------------ sync
  async function refreshSyncStatus() {
    syncStatus = await api.syncStatus();
    if (!syncStatus.configured) sync = { state: "off", message: "" };
    else if (sync.state !== "syncing")
      sync = { state: syncStatus.lastError ? "error" : "idle", message: syncStatus.lastError };
  }

  let syncing: Promise<void> | null = null;
  async function syncNow(silent = true) {
    if (!syncStatus?.configured) return;
    if (syncing) return syncing;
    sync = { state: "syncing", message: "" };
    syncing = (async () => {
      try {
        const summary = await api.syncNow();
        sync = { state: "idle", message: summary };
        if (!silent) say(summary);
        await loadTimelines();
        // Don't yank the editor out from under someone mid-sentence: just refresh the list.
        await loadNotes();
      } catch (e) {
        sync = { state: "error", message: String(e) };
        if (!silent) say(String(e), "error");
      } finally {
        syncing = null;
        await refreshSyncStatus();
      }
    })();
    return syncing;
  }

  // Push edits a little while after the last change, rather than on every keystroke.
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  function queueSync() {
    clearTimeout(syncTimer);
    if (syncStatus?.configured) syncTimer = setTimeout(() => syncNow(), 60_000);
  }

  async function connect(remote: string) {
    await api.syncConfigure(remote);
    await refreshSyncStatus();
    if (remote.trim()) await syncNow(false);
  }

  // --------------------------------------------------------------- startup
  onMount(() => {
    if (/Mac/.test(navigator.platform)) document.documentElement.classList.add("mac");
    try {
      showLinks = localStorage.getItem("showLinks") === "1";
      currentId = localStorage.getItem("timeline") || MASTER_ID;
    } catch {}
    (async () => {
      await loadPrefs();
      await loadTimelines();
      await loadNotes();
      await refreshSyncStatus();
      void syncNow();
    })();
    const every = setInterval(() => syncNow(), 5 * 60_000);
    return () => clearInterval(every);
  });

  function onKey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    const typing = (e.target as HTMLElement).closest("input, textarea, select, .cm-editor");
    if (mod && e.key === "n") (e.preventDefault(), newNote());
    else if (mod && e.key === ",") (e.preventDefault(), (modal = "settings"));
    else if (mod && !e.shiftKey && e.key === "f") (e.preventDefault(), searchEl?.focus());
    else if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      if (editing) fullscreen = !fullscreen;
    } else if (e.key === "Escape" && !(e.target as HTMLElement).closest(".cm-editor")) {
      if (modal) modal = "";
      else if (fullscreen) fullscreen = false;
      else editing = null;
    } else if (!typing && !mod) {
      if (e.key === "=" || e.key === "+") timeline?.zoom(1.4);
      else if (e.key === "-") timeline?.zoom(1 / 1.4);
      else if (e.key === "0") timeline?.fit();
    }
  }

  function toggleLinks() {
    showLinks = !showLinks;
    try { localStorage.setItem("showLinks", showLinks ? "1" : "0"); } catch {}
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="app">
  <Sidebar
    {timelines}
    {currentId}
    {notes}
    selectedId={editing?.id || null}
    {sync}
    bind:searchEl
    onSelectTimeline={selectTimeline}
    onCreateTimeline={createTimeline}
    onRenameTimeline={renameTimeline}
    onDeleteTimeline={deleteTimeline}
    onOpenNote={(n) => openNote(n)}
    onSettings={() => (modal = "settings")}
    onActivity={openActivity}
    onSync={() => (syncStatus?.configured ? syncNow(false) : (modal = "settings"))}
  />

  <main>
    <div class="topbar" data-tauri-drag-region>
      <div class="heading" data-tauri-drag-region>
        <h1 data-tauri-drag-region>{current?.name ?? ""}</h1>
        <span data-tauri-drag-region>{notes.length} note{notes.length === 1 ? "" : "s"}</span>
      </div>
      <div class="tools glass">
        <button class="icon-btn" title="Zoom out (−)" onclick={() => timeline?.zoom(1 / 1.5)}><Minus size={16} /></button>
        <button class="icon-btn" title="Zoom in (+)" onclick={() => timeline?.zoom(1.5)}><Plus size={16} /></button>
        <button class="icon-btn" title="Fit all notes (0)" onclick={() => timeline?.fit()}><Maximize2 size={15} /></button>
        <span class="sep"></span>
        <button class="icon-btn" class:on={showLinks} title="Show all links" onclick={toggleLinks}><Spline size={16} /></button>
        <button class="icon-btn" title="Toggle theme" onclick={() => setPref("theme", isDark() ? "light" : "dark")}>
          {#if isDark()}<Sun size={16} />{:else}<Moon size={16} />{/if}
        </button>
      </div>
      <button class="btn primary" onclick={() => newNote()} title="New note (⌘N)"><Plus size={16} /> New note</button>
    </div>

    <TimelineView
      bind:this={timeline}
      {notes}
      timelineId={currentId}
      selectedId={editing?.id || null}
      {showLinks}
      markerSets={MARKER_SETS.filter((m) => prefs.markers.includes(m.id))}
      {flashId}
      onOpenFull={openFull}
      onSelect={(id) => openNote(notes.find((n) => n.id === id)!, false)}
      onMove={moveNote}
      onCreateAt={createAt}
    />

    {#if notes.length === 0 && !editing}
      <div class="empty glass">
        <h2>An empty stretch of history</h2>
        <p>Double-click anywhere on the line to add a note at that date, or press <kbd>⌘</kbd><kbd>N</kbd>.</p>
      </div>
    {/if}

    {#if editing}
      {#key editorKey}
        <NoteEditor
          note={editing}
          {notes}
          onSave={saveNote}
          onDelete={deleteNote}
          onClose={closeEditor}
          {fullscreen}
          onToggleFullscreen={() => (fullscreen = !fullscreen)}
          onOpenLink={openLink}
          onOpenUrl={openUrl}
        />
      {/key}
    {/if}

    {#if toast}
      <div class="toast glass-strong" class:error={toast.kind === "error"} role="status">{toast.text}</div>
    {/if}
  </main>
</div>

{#if modal === "settings"}
  <Settings
    sync={syncStatus}
    timeline={current}
    onConnect={connect}
    onSyncNow={() => syncNow(false)}
    onExport={exportTimeline}
    onImport={importTimeline}
    onClose={() => (modal = "")}
  />
{:else if modal === "activity"}
  <Activity notes={allNotes} {timelines} onOpen={(n) => ((modal = ""), openNote(n))} onClose={() => (modal = "")} />
{/if}

{#if prefs.loaded && !prefs.welcomed}
  <Welcome onConnect={connect} onDone={() => setPref("welcomed", true)} />
{/if}

<style>
  .app {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: 264px 1fr;
    height: 100vh;
  }
  main {
    position: relative;
    overflow: hidden;
  }
  .topbar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 15;
    height: 64px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 18px 0 22px;
    pointer-events: none;
  }
  .topbar > * {
    pointer-events: auto;
  }
  .heading {
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }
  h1 {
    font: 600 22px var(--font-serif);
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .heading span {
    color: var(--text-3);
    font-size: 12.5px;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    border-radius: 11px;
  }
  .tools .on {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .sep {
    width: 1px;
    height: 18px;
    background: var(--hairline);
    margin: 0 3px;
  }
  .empty {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, calc(-50% - 90px));
    padding: 20px 26px;
    border-radius: 16px;
    text-align: center;
    pointer-events: none;
  }
  .empty h2 {
    font: 600 19px var(--font-serif);
    margin: 0 0 4px;
  }
  .empty p {
    margin: 0;
    color: var(--text-2);
  }
  .toast {
    position: absolute;
    left: 50%;
    bottom: 22px;
    transform: translateX(-50%);
    padding: 9px 16px;
    border-radius: 11px;
    z-index: 30;
    font-weight: 500;
    animation: rise 0.2s ease-out;
    max-width: 70%;
  }
  .toast.error {
    color: #c4552e;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
  }
</style>
