<script lang="ts">
  interface Props {
    onConnect: (remote: string) => Promise<void>;
    onDone: () => void;
  }
  let { onConnect, onDone }: Props = $props();

  let remote = $state("");
  let busy = $state(false);
  let error = $state("");

  async function connect(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    try {
      await onConnect(remote);
      onDone();
    } catch (err) {
      error = String(err);
    }
    busy = false;
  }
</script>

<div class="scrim" aria-hidden="true"></div>
<div class="modal glass-strong" role="dialog" aria-label="Welcome">
  <svg class="mark" width="56" height="56" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M2 12h20" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".4" />
    <path d="M7 12V5h6M16 12v6h5" stroke="currentColor" stroke-width="1.2" fill="none" opacity=".4" />
    <circle cx="7" cy="12" r="2" fill="var(--accent)" />
    <circle cx="16" cy="12" r="2" fill="var(--accent)" />
  </svg>
  <h1>Welcome to Timeline</h1>
  <p class="lede">
    Put what you read in its place in history. Every note has a date, from the Big Bang to this morning. Link notes with
    <code>[[Title]]</code> and see how works answer, borrow from and contradict each other across the centuries.
  </p>

  <div class="sync">
    <h2>Sync across your devices <span>optional</span></h2>
    <p>
      Create an empty <b>private</b> repo on GitHub and paste its link here. The app uses your computer's own git login
      and never sees a password. You can do this later in Settings.
    </p>
    <form onsubmit={connect}>
      <input class="field" bind:value={remote} placeholder="git@github.com:you/timeline-vault.git" spellcheck="false" />
      <button class="btn primary" disabled={busy || !remote.trim()}>{busy ? "Connecting…" : "Connect"}</button>
    </form>
    {#if error}<p class="error">{error}</p>{/if}
  </div>

  <button class="btn skip" onclick={onDone}>{remote.trim() ? "Skip for now" : "Start on this device"} →</button>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(20, 14, 4, 0.22);
    z-index: 50;
  }
  .modal {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: min(540px, calc(100vw - 48px));
    border-radius: 22px;
    padding: 34px 36px 24px;
    z-index: 51;
    text-align: center;
    animation: pop 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes pop {
    from { opacity: 0; transform: translate(-50%, -46%) scale(0.97); }
  }
  .mark {
    color: var(--text);
  }
  h1 {
    font: 600 30px var(--font-serif);
    margin: 6px 0 8px;
  }
  .lede {
    font: 400 15.5px/1.6 var(--font-serif);
    color: var(--text-2);
    margin: 0 0 22px;
  }
  code {
    font: 13px var(--font-mono);
    color: var(--accent-ink);
  }
  .sync {
    text-align: left;
    padding: 16px 18px;
    border-radius: 14px;
    background: var(--field);
    border: 1px solid var(--hairline);
  }
  h2 {
    font: 600 14px var(--font-ui);
    margin: 0 0 4px;
  }
  h2 span {
    font-weight: 500;
    font-size: 11px;
    color: var(--text-3);
    margin-left: 4px;
  }
  .sync p {
    margin: 0 0 12px;
    color: var(--text-2);
  }
  form {
    display: flex;
    gap: 8px;
  }
  .error {
    color: #c4552e;
    margin: 8px 0 0 !important;
  }
  .skip {
    margin-top: 16px;
    color: var(--text-2);
  }
</style>
