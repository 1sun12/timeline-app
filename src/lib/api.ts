import { invoke } from "@tauri-apps/api/core";

export interface Timeline {
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
}

export interface Note {
  id: string;
  timelineId: string;
  title: string;
  author: string;
  year: number;
  month: number | null;
  day: number | null;
  hour: number | null;
  minute: number | null;
  body: string;
  pinned: boolean;
  offsetX: number;
  offsetY: number;
  createdAt: string;
  modifiedAt: string;
}

export interface SyncStatus {
  configured: boolean;
  gitAvailable: boolean;
  remote: string;
  lastSynced: string;
  lastError: string;
}

export const MASTER_ID = "master";

export const blankNote = (timelineId: string, partial: Partial<Note> = {}): Note => ({
  id: "",
  timelineId,
  title: "",
  author: "",
  year: new Date().getFullYear(),
  month: null,
  day: null,
  hour: null,
  minute: null,
  body: "",
  pinned: false,
  offsetX: 0,
  offsetY: 0,
  createdAt: "",
  modifiedAt: "",
  ...partial,
});

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// In a plain browser (`npm run dev` without Tauri) calls go to an in-memory mock,
// so the UI can be previewed and screenshotted without the native shell.
const call = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  inTauri ? invoke<T>(cmd, args) : import("./mock").then((m) => m.mock(cmd, args) as T);

export const api = {
  listTimelines: () => call<Timeline[]>("list_timelines"),
  saveTimeline: (timeline: Partial<Timeline>) =>
    call<Timeline>("save_timeline", { timeline: { id: "", name: "", createdAt: "", modifiedAt: "", ...timeline } }),
  deleteTimeline: (id: string) => call<void>("delete_timeline", { id }),
  listNotes: (timelineId: string) => call<Note[]>("list_notes", { timelineId }),
  allNotes: () => call<Note[]>("all_notes"),
  saveNote: (note: Note) => call<Note>("save_note", { note }),
  deleteNote: (id: string) => call<void>("delete_note", { id }),
  getSettings: () => call<Record<string, string>>("get_settings"),
  setSetting: (key: string, value: string) => call<void>("set_setting", { key, value }),
  exportTimeline: (id: string, path: string) => call<void>("export_timeline", { id, path }),
  importTimeline: (path: string) => call<Timeline>("import_timeline", { path }),
  syncStatus: () => call<SyncStatus>("sync_status"),
  syncConfigure: (remote: string) => call<void>("sync_configure", { remote }),
  syncNow: () => call<string>("sync_now"),
};

export const isTauri = inTauri;
