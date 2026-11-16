<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView, basicSetup } from "codemirror";
  import { placeholder } from "@codemirror/view";
  import { Compartment, EditorState } from "@codemirror/state";
  import { markdown } from "@codemirror/lang-markdown";
  import { vim } from "@replit/codemirror-vim";

  interface Props {
    value: string;
    vimMode: boolean;
    onChange: (value: string) => void;
  }
  let { value, vimMode, onChange }: Props = $props();

  let host: HTMLDivElement;
  let view: EditorView;
  const keymapMode = new Compartment();

  const theme = EditorView.theme({
    "&": { height: "100%", fontSize: "14px", background: "transparent", color: "var(--text)" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65" },
    ".cm-content": { padding: "12px 0", caretColor: "var(--accent)" },
    ".cm-line": { padding: "0 18px" },
    ".cm-placeholder": { color: "var(--text-3)" },
    "&.cm-focused": { outline: "none" },
    ".cm-gutters": { display: "none" },
    ".cm-activeLine": { background: "transparent" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
      background: "var(--accent-soft) !important",
    },
    ".cm-cursor": { borderLeftColor: "var(--accent)" },
    ".cm-fat-cursor": { background: "var(--accent) !important", color: "var(--bg) !important" },
    ".cm-panels": { background: "var(--glass-strong)", color: "var(--text)", borderTop: "1px solid var(--hairline)" },
    ".cm-vim-panel input": { color: "var(--text)", fontFamily: "var(--font-mono)" },
    ".cm-matchingBracket": { background: "var(--accent-soft) !important", outline: "none" },
  });

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          // vim() must come before basicSetup so its keys take priority.
          keymapMode.of(vimMode ? vim() : []),
          basicSetup,
          markdown(),
          placeholder("Write in Markdown. Link other notes with [[Title]]."),
          EditorView.lineWrapping,
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    return () => view.destroy();
  });

  $effect(() => {
    view?.dispatch({ effects: keymapMode.reconfigure(vimMode ? vim() : []) });
  });

  // Replace the document when a different note is loaded.
  $effect(() => {
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  });

  export const focus = () => view?.focus();
</script>

<div class="editor" bind:this={host}></div>

<style>
  .editor {
    height: 100%;
    min-height: 0;
  }
  .editor :global(.cm-editor) {
    height: 100%;
  }
  .editor :global(.cm-header) {
    font-weight: 700;
    color: var(--text);
    text-decoration: none;
  }
  .editor :global(.cm-link),
  .editor :global(.cm-url) {
    color: var(--accent-ink);
  }
</style>
