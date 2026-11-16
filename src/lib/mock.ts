// Browser-only stand-in for the Rust backend, used when the UI runs outside
// Tauri (UI previews). Data lives in memory and resets on reload.
import { blankNote, MASTER_ID, type Note, type Timeline } from "./api";

const now = () => new Date().toISOString();
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString();
let seq = 0;
const id = () => `mock-${++seq}`;

const timelines: Timeline[] = [
  { id: MASTER_ID, name: "Master", createdAt: "1970-01-01T00:00:00.000Z", modifiedAt: "1970-01-01T00:00:00.000Z" },
  { id: "phil", name: "Philosophy", createdAt: now(), modifiedAt: now() },
];

const sample: [string, string, number, string][] = [
  ["The Iliad", "Homer", -750, "War, rage and honour. Compare with [[The Odyssey]]."],
  ["The Odyssey", "Homer", -725, "The long way home. Follows [[The Iliad]]."],
  ["The Republic", "Plato", -375, `## What it's about
Socrates and friends try to define **justice**, and end up designing an ideal city to find it.

> "Until philosophers rule as kings, cities will never have rest from their evils."

## Big ideas
- The tripartite soul: reason, spirit and appetite
- Philosopher kings, and why they shouldn't want the job
- The allegory of the cave (Book VII)
- Art as an imitation of an imitation

## Connections
- Aristotle pushes back on the ideal city in [[Politics]]
- Augustine reads it through Neoplatonism in [[Confessions]]
- [[The Prince]] is basically the anti-Republic: power as it is, not as it should be

## My notes
Read the Bloom translation. Book I is a warm-up; it really starts in Book II with the ring of Gyges.`],
  ["Apology", "Plato", -399, "Socrates on trial."],
  ["Politics", "Aristotle", -350, "A reply to [[The Republic]]."],
  ["Nicomachean Ethics", "Aristotle", -340, "Virtue as a mean. See [[Politics]]."],
  ["Meditations", "Marcus Aurelius", 175, "Stoic notes to self; echoes [[Apology]]."],
  ["Confessions", "Augustine", 400, "Memory and time, book XI. Reads [[The Republic]] through Neoplatonism."],
  ["The Prince", "Machiavelli", 1532, "Power as it is. Against [[The Republic]]."],
  ["Leviathan", "Thomas Hobbes", 1651, "The state of nature. Builds on [[The Prince]]."],
];
const notes: Note[] = sample.map(([title, author, year, body], i) => ({
  ...blankNote(MASTER_ID, { title, author, year, body }),
  id: id(),
  createdAt: daysAgo(i * 9 + (i % 3)),
  modifiedAt: now(),
}));
// ?welcome shows the first-run screen.
const settings: Record<string, string> = { welcomed: location.search.includes("welcome") ? "" : "1" };

export function mock(cmd: string, a: any = {}): unknown {
  switch (cmd) {
    case "list_timelines": return [...timelines];
    case "save_timeline": {
      const t = { ...a.timeline, id: a.timeline.id || id(), modifiedAt: now() };
      const i = timelines.findIndex((x) => x.id === t.id);
      i < 0 ? timelines.push(t) : (timelines[i] = t);
      return t;
    }
    case "delete_timeline":
      if (a.id === MASTER_ID) throw "The Master timeline can't be deleted";
      timelines.splice(timelines.findIndex((t) => t.id === a.id), 1);
      return;
    case "list_notes": return notes.filter((n) => n.timelineId === a.timelineId);
    case "all_notes": return [...notes];
    case "save_note": {
      if (a.note.year === 0) throw "There is no year 0 — use 1 AD or 1 BCE";
      const n = { ...a.note, id: a.note.id || id(), createdAt: a.note.createdAt || now(), modifiedAt: now() };
      const i = notes.findIndex((x) => x.id === n.id);
      i < 0 ? notes.push(n) : (notes[i] = n);
      return n;
    }
    case "delete_note": notes.splice(notes.findIndex((n) => n.id === a.id), 1); return;
    case "get_settings": return { ...settings };
    case "set_setting": settings[a.key] = a.value; return;
    case "sync_status": return { configured: false, gitAvailable: true, remote: "", lastSynced: "", lastError: "" };
    case "sync_configure": settings.sync_remote = a.remote; return;
    case "sync_now": return "Up to date";
    default: throw `${cmd} isn't available in the browser preview`;
  }
}
