//! Sync through a private git repo, the same design as Bonfire:
//! fetch → read remote and last-synced trees → merge as records → write SQLite
//! and the tree → commit (two parents when both sides moved) → push.
//! Git never merges file contents, so a textual conflict cannot happen.
//!
//! Vault layout (one file per record so git diffs stay small):
//!   timelines/<id>.json   notes/<id>.json   tombstones.json

use crate::db;
use crate::git;
use crate::merge::{self, VaultData};
use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const REMOTE: &str = "sync_remote";
const LAST: &str = "sync_last";
const LAST_ERROR: &str = "sync_last_error";
const MAX_ATTEMPTS: u8 = 3;
const PUSH_RACE: &str = "__push_race__";

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub configured: bool,
    pub git_available: bool,
    pub remote: String,
    pub last_synced: String,
    pub last_error: String,
}

pub fn vault_dir(app_dir: &Path) -> PathBuf {
    app_dir.join("vault")
}

fn setting(conn: &Connection, key: &str) -> String {
    db::get_setting(conn, key).ok().flatten().unwrap_or_default()
}

pub fn status(conn: &Connection) -> SyncStatus {
    let remote = setting(conn, REMOTE);
    SyncStatus {
        configured: !remote.is_empty(),
        git_available: git::is_available(),
        remote,
        last_synced: setting(conn, LAST),
        last_error: setting(conn, LAST_ERROR),
    }
}

/// Point this device at a remote; an empty string disconnects.
pub fn configure(conn: &Connection, app_dir: &Path, remote: &str) -> Result<(), String> {
    let remote = remote.trim();
    if !remote.is_empty() {
        if !git::is_available() {
            return Err("git is not installed — on a Mac run `xcode-select --install`".into());
        }
        git::ensure_repo(&vault_dir(app_dir), remote)?;
    }
    db::set_setting(conn, REMOTE, remote).map_err(|e| e.to_string())
}

// ------------------------------------------------------------- tree <-> data

fn read_dir_json<T: serde::de::DeserializeOwned>(dir: &Path) -> Result<Vec<T>, String> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(out);
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().is_some_and(|x| x == "json") {
            let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
            out.push(serde_json::from_str(&text).map_err(|e| format!("{}: {e}", p.display()))?);
        }
    }
    Ok(out)
}

pub fn read_tree(dir: &Path) -> Result<VaultData, String> {
    let tombstones = match std::fs::read_to_string(dir.join("tombstones.json")) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| e.to_string())?,
        Err(_) => Vec::new(),
    };
    Ok(VaultData {
        timelines: read_dir_json(&dir.join("timelines"))?,
        notes: read_dir_json(&dir.join("notes"))?,
        tombstones,
    })
}

/// Rewrite the record folders to exactly match `data`.
pub fn write_tree(dir: &Path, data: &VaultData) -> Result<(), String> {
    fn write_all<T: Serialize>(dir: &Path, items: &[T], id: impl Fn(&T) -> &str) -> Result<(), String> {
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        for it in items {
            let json = serde_json::to_string_pretty(it).map_err(|e| e.to_string())?;
            std::fs::write(dir.join(format!("{}.json", id(it))), json + "\n").map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    write_all(&dir.join("timelines"), &data.timelines, |t| &t.id)?;
    write_all(&dir.join("notes"), &data.notes, |n| &n.id)?;
    let stones = serde_json::to_string_pretty(&data.tombstones).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("tombstones.json"), stones + "\n").map_err(|e| e.to_string())
}

fn read_db(conn: &Connection) -> Result<VaultData, String> {
    Ok(VaultData {
        timelines: db::list_timelines(conn).map_err(|e| e.to_string())?,
        notes: db::all_notes(conn).map_err(|e| e.to_string())?,
        tombstones: db::list_tombstones(conn).map_err(|e| e.to_string())?,
    })
}

fn read_rev(dir: &Path, rev: &str) -> Result<VaultData, String> {
    let scratch = git::Scratch::new("rev").map_err(|e| e.to_string())?;
    git::export_tree(dir, rev, &scratch.0)?;
    read_tree(&scratch.0)
}

// ------------------------------------------------------------------ the loop

/// Run one sync. The database lock is held only while merging, never during
/// network calls, so the UI stays responsive.
pub fn sync_now(db: &Mutex<Connection>, app_dir: &Path) -> Result<String, String> {
    let result = run(db, app_dir);
    let conn = db.lock().map_err(|e| e.to_string())?;
    match &result {
        Ok(_) => {
            let _ = db::set_setting(&conn, LAST, &db::now());
            let _ = db::set_setting(&conn, LAST_ERROR, "");
        }
        Err(e) => {
            let _ = db::set_setting(&conn, LAST_ERROR, e);
        }
    }
    result
}

fn run(db: &Mutex<Connection>, app_dir: &Path) -> Result<String, String> {
    let remote = setting(&*db.lock().map_err(|e| e.to_string())?, REMOTE);
    if remote.is_empty() {
        return Err("Sync isn't set up (Settings → Sync)".into());
    }
    let dir = vault_dir(app_dir);
    git::ensure_repo(&dir, &remote)?;
    for attempt in 1..=MAX_ATTEMPTS {
        match attempt_sync(db, &dir) {
            Err(e) if e == PUSH_RACE && attempt < MAX_ATTEMPTS => continue,
            Err(e) if e == PUSH_RACE => return Err("The remote kept changing — try again".into()),
            other => return other,
        }
    }
    unreachable!()
}

fn attempt_sync(db: &Mutex<Connection>, dir: &Path) -> Result<String, String> {
    let first = git::base_commit(dir).is_none() && git::remote_is_empty(dir)?;
    if !first {
        git::fetch(dir)?;
    }
    let remote_head = git::remote_head(dir);
    let remote = match &remote_head {
        Some(rev) => read_rev(dir, rev)?,
        None => VaultData::default(),
    };
    let base = git::base_commit(dir).and_then(|rev| read_rev(dir, &rev).ok());

    let (summary, committed) = {
        let mut conn = db.lock().map_err(|e| e.to_string())?;
        let local = read_db(&conn)?;
        let (merged, conflicts) = if first {
            (local.clone(), 0)
        } else {
            merge::merge(base.as_ref(), &local, &remote)
        };
        if merged != local {
            db::replace_all(&mut conn, &merged.timelines, &merged.notes, &merged.tombstones)
                .map_err(|e| e.to_string())?;
            db::init(&conn).map_err(|e| e.to_string())?; // re-seed Master if a merge dropped it
        }
        write_tree(dir, &merged)?;
        let msg = format!("sync: {} notes in {} timelines", merged.notes.len(), merged.timelines.len());
        let committed = git::commit_all(dir, &msg, remote_head.as_deref())?;
        let incoming = merged.notes.len() as i64 - local.notes.len() as i64;
        (summary(incoming, conflicts), committed)
    };

    if committed.is_some() {
        git::push(dir).map_err(|e| {
            if e.contains("non-fast-forward") || e.contains("fetch first") || e.contains("rejected") {
                PUSH_RACE.to_string()
            } else {
                e
            }
        })?;
    }
    if let Some(id) = committed.or_else(|| git::local_head(dir)) {
        git::set_base(dir, &id)?;
    }
    Ok(summary)
}

fn summary(incoming: i64, conflicts: usize) -> String {
    let s = |n: i64| if n.abs() == 1 { "" } else { "s" };
    let mut out = match incoming {
        0 => "Up to date".to_string(),
        n if n > 0 => format!("{n} note{} received", s(n)),
        n => format!("{} note{} removed", -n, s(n)),
    };
    if conflicts > 0 {
        out += &format!(" · {conflicts} conflict cop{} kept", if conflicts == 1 { "y" } else { "ies" });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Note, MASTER_ID};
    use std::process::Command;

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct Device {
        db: Mutex<Connection>,
        dir: PathBuf,
    }

    impl Device {
        fn new(root: &Path, name: &str, remote: &str) -> Self {
            let dir = root.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            let conn = Connection::open_in_memory().unwrap();
            db::init(&conn).unwrap();
            configure(&conn, &dir, remote).unwrap();
            Device { db: Mutex::new(conn), dir }
        }
        fn sync(&self) -> String {
            sync_now(&self.db, &self.dir).unwrap()
        }
        fn add(&self, id: &str, title: &str) {
            let n = Note {
                id: id.into(),
                timeline_id: MASTER_ID.into(),
                title: title.into(),
                year: -400,
                modified_at: db::now(),
                ..Default::default()
            };
            db::save_note(&self.db.lock().unwrap(), &n).unwrap();
        }
        fn titles(&self) -> Vec<String> {
            let mut t: Vec<_> = db::all_notes(&self.db.lock().unwrap())
                .unwrap()
                .into_iter()
                .map(|n| n.title)
                .collect();
            t.sort();
            t
        }
    }

    #[test]
    fn two_devices_converge_and_deletes_propagate() {
        let root = Tmp(std::env::temp_dir().join(format!("timeline-sync-{}", db::generate_id())));
        let remote = root.0.join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        Command::new("git").args(["init", "--bare", "-q", "-b", "main"]).arg(&remote).output().unwrap();
        let remote = remote.to_string_lossy().to_string();

        let a = Device::new(&root.0, "a", &remote);
        let b = Device::new(&root.0, "b", &remote);

        a.add("1", "Republic");
        a.sync();
        b.add("2", "Meditations");
        assert_eq!(b.sync(), "1 note received");
        a.sync();
        assert_eq!(a.titles(), ["Meditations", "Republic"]);
        assert_eq!(a.titles(), b.titles());

        db::delete_note(&a.db.lock().unwrap(), "1").unwrap();
        a.sync();
        b.sync();
        assert_eq!(b.titles(), ["Meditations"], "delete reached the other device");
        b.sync();
        assert_eq!(b.titles(), ["Meditations"], "and stays deleted");
        assert_eq!(db::list_timelines(&b.db.lock().unwrap()).unwrap().len(), 1, "Master is shared, not duplicated");
    }
}
