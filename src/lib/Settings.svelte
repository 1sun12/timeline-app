<script lang="ts">
  import { untrack } from "svelte";
  import { X, Sun, Moon, Monitor, Upload, Download, RotateCcw } from "@lucide/svelte";
  import type { SyncStatus, Timeline } from "./api";
  import { prefs, setPref, DEFAULT_ACCENT } from "./prefs.svelte";
  import { MARKER_SETS } from "./eras";

  function toggleMarkers(id: string, on: boolean) {
    setPref("markers", on ? [...prefs.markers, id] : prefs.markers.filter((m) => m !== id));
  }

  interface Props {
    sync: SyncStatus | null;
    timeline: Timeline | undefined;
    onConnect: (remote: string) => Promise<void>;
    onSyncNow: () => void;
    onExport: () => void;
    onImport: () => void;
    onClose: () => void;
  }
  let { sync, timeline, onConnect, onSyncNow, onExport, onImport, onClose }: Props = $props();

  const PRESETS = {
    light: ["#b8862f", "#b5583a", "#7d8a3c", "#2f7f7a", "#4a6aa5", "#8a4f7d"],
    dark: ["#d27a26", "#e0a84f", "#d9694a", "#9fb05a", "#4fb3a9", "#7f9de0"],
  };

  let remote = $state(untrack(() => sync?.remote ?? ""));
  let busy = $state(false);
  let syncError = $state("");

  async function connect(value: string) {
    busy = true;
    syncError = "";
    try {
      await onConnect(value);
    } catch (e) {
      syncError = String(e);
    }
    busy = false;
  }
  const when = (iso: string) => (iso ? new Date(iso).toLocaleString() : "never");
</script>

<div class="scrim" onclick={onClose} aria-hidden="true"></div>
<div class="modal glass-strong" role="dialog" aria-label="Settings">
  <header>
    <h2>Settings</h2>
    <button class="icon-btn" onclick={onClose} title="Close (Esc)"><X size={17} /></button>
  </header>

  <section>
    <h3>Appearance</h3>
    <div class="row">
      <span>Theme</span>
      <div class="segmented">
        <button class:on={prefs.theme === "light"} onclick={() => setPref("theme", "light")}><Sun size={13} /> Cream</button>
        <button class:on={prefs.theme === "dark"} onclick={() => setPref("theme", "dark")}><Moon size={13} /> Matte</button>
        <button class:on={prefs.theme === "system"} onclick={() => setPref("theme", "system")}><Monitor size={13} /> System</button>
      </div>
    </div>
    {#each [["light", "accentLight", "Accent · cream theme"], ["dark", "accentDark", "Accent · matte theme"]] as const as [mode, k, label]}
      <div class="row">
        <span>{label}</span>
        <div class="swatches">
          {#each PRESETS[mode] as c}
            <button class="swatch" class:on={prefs[k] === c} style:background={c} title={c} aria-label="Use {c}" onclick={() => setPref(k, c)}></button>
          {/each}
          <label class="swatch custom" title="Custom colour">
            <input type="color" value={prefs[k]} oninput={(e) => setPref(k, e.currentTarget.value)} />
          </label>
          {#if prefs[k] !== DEFAULT_ACCENT[mode]}
            <button class="icon-btn" title="Reset to default" onclick={() => setPref(k, DEFAULT_ACCENT[mode])}><RotateCcw size={13} /></button>
          {/if}
        </div>
      </div>
    {/each}
  </section>

  <section>
    <h3>Timeline markers</h3>
    <p class="help">The BCE / AD divide is always shown. Add reference eras to see where your notes sit in deeper time.</p>
    {#each MARKER_SETS as set (set.id)}
      <label class="row toggle">
        <span>{set.name} <small>{set.description}</small></span>
        <input type="checkbox" checked={prefs.markers.includes(set.id)} onchange={(e) => toggleMarkers(set.id, e.currentTarget.checked)} />
        <span class="switch" aria-hidden="true"></span>
      </label>
    {/each}
  </section>

  <section>
    <h3>Editor</h3>
    <label class="row toggle">
      <span>Vim keybindings <small>Modal editing in the note editor</small></span>
      <input type="checkbox" checked={prefs.vim} onchange={(e) => setPref("vim", e.currentTarget.checked)} />
      <span class="switch" aria-hidden="true"></span>
    </label>
  </section>

  <section>
    <h3>Sync</h3>
    <p class="help">
      Keeps your timelines the same on every device through a <b>private</b> GitHub repo you create (empty is fine).
      It uses your computer's own git login, so the app never sees a password.
    </p>
    <form class="remote" onsubmit={(e) => (e.preventDefault(), connect(remote))}>
      <input class="field" bind:value={remote} placeholder="git@github.com:you/timeline-vault.git" spellcheck="false" />
      <button class="btn primary" disabled={busy || !remote.trim() || remote.trim() === sync?.remote}>Connect</button>
    </form>
    {#if sync?.configured}
      <div class="sync-row">
        <span>Last synced {when(sync.lastSynced)}</span>
        <button class="btn" onclick={onSyncNow}>Sync now</button>
        <button class="btn danger" onclick={() => ((remote = ""), connect(""))}>Disconnect</button>
      </div>
    {/if}
    {#if syncError || sync?.lastError}<p class="error">{syncError || sync?.lastError}</p>{/if}
    {#if sync && !sync.gitAvailable}<p class="error">git isn't installed. On a Mac, run <code>xcode-select --install</code> in Terminal.</p>{/if}
  </section>

  <section>
    <h3>Share</h3>
    <p class="help">Export a timeline as a file to send to someone; importing adds it as a new timeline.</p>
    <div class="share">
      <button class="btn" onclick={onExport} disabled={!timeline}><Upload size={14} /> Export “{timeline?.name}”</button>
      <button class="btn" onclick={onImport}><Download size={14} /> Import timeline…</button>
    </div>
  </section>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(20, 14, 4, 0.18);
    z-index: 40;
  }
  .modal {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: min(600px, calc(100vw - 48px));
    max-height: calc(100vh - 64px);
    overflow: auto;
    border-radius: 20px;
    padding: 20px 26px 10px;
    z-index: 41;
    animation: pop 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes pop {
    from { opacity: 0; transform: translate(-50%, -48%) scale(0.98); }
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    font: 600 24px var(--font-serif);
    margin: 0;
  }
  section {
    padding: 16px 0;
    border-bottom: 1px solid var(--hairline);
  }
  section:last-child {
    border: 0;
  }
  h3 {
    font: 600 10.5px var(--font-ui);
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-3);
    margin: 0 0 10px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 40px;
  }
  .row small {
    display: block;
    color: var(--text-3);
    font-size: 11.5px;
  }
  .segmented button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .swatches {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .swatch {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2px solid transparent;
    box-shadow: 0 0 0 1px var(--hairline) inset;
    transition: transform 0.12s;
  }
  .swatch:hover {
    transform: scale(1.12);
  }
  .swatch.on {
    border-color: var(--glass-strong);
    box-shadow: 0 0 0 2px var(--text-2);
  }
  .swatch.custom {
    position: relative;
    overflow: hidden;
    cursor: pointer;
    background: conic-gradient(#e0a84f, #d9694a, #8a4f7d, #4a6aa5, #2f7f7a, #7d8a3c, #e0a84f);
  }
  .swatch.custom input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  .toggle {
    cursor: pointer;
  }
  .toggle input {
    position: absolute;
    opacity: 0;
  }
  .switch {
    width: 38px;
    height: 22px;
    border-radius: 11px;
    background: var(--field);
    border: 1px solid var(--hairline);
    position: relative;
    flex: none;
    transition: background 0.18s;
  }
  .switch::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    transition: transform 0.18s;
  }
  .toggle input:checked + .switch {
    background: var(--accent);
  }
  .toggle input:checked + .switch::after {
    transform: translateX(16px);
  }
  .toggle input:focus-visible + .switch {
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .help {
    color: var(--text-2);
    margin: 0 0 10px;
  }
  .remote {
    display: flex;
    gap: 8px;
  }
  .sync-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
    color: var(--text-2);
    font-size: 12.5px;
  }
  .sync-row span {
    flex: 1;
  }
  .error {
    color: #c4552e;
    margin: 8px 0 0;
    font-size: 12.5px;
  }
  .share {
    display: flex;
    gap: 8px;
  }
  .share .btn {
    border: 1px solid var(--hairline);
    background: var(--field);
  }
</style>
