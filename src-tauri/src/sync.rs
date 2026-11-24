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
    check_remote(remote)?;
    if !remote.is_empty() {
        if !git::is_available() {
            return Err("git is not installed — on a Mac run `xcode-select --install`".into());
        }
        git::ensure_repo(&vault_dir(app_dir), remote)?;
    }
    db::set_setting(conn, REMOTE, remote).map_err(|e| e.to_string())
}

/// The link is handed to git, so refuse anything git would read as an option or a
/// transport helper, and links that would store a password in plain text.
fn check_remote(remote: &str) -> Result<(), String> {
    if remote.starts_with('-') || remote.contains("::") {
        return Err("That doesn't look like a git repo link".into());
    }
    let lower = remote.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")) {
        if rest.split('/').next().is_some_and(|host| host.contains('@')) {
            return Err("Don't put a password or token in the link — git uses your saved login".into());
        }
    }
    Ok(())
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

/// Read a vault tree, skipping records that fail validation: the tree may come
/// from another device, and one bad record must not stop sync. Returns how many
/// were skipped; the next write drops them from the tree.
pub fn read_tree(dir: &Path) -> Result<(VaultData, usize), String> {
    let tombstones = match std::fs::read_to_string(dir.join("tombstones.json")) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| e.to_string())?,
        Err(_) => Vec::new(),
    };
    let mut timelines: Vec<db::Timeline> = read_dir_json(&dir.join("timelines"))?;
    let mut notes: Vec<db::Note> = read_dir_json(&dir.join("notes"))?;
    let before = timelines.len() + notes.len();
    timelines.retain(|t| db::valid_id(&t.id));
    notes.retain(|n| db::validate(n).is_ok());
    let skipped = before - timelines.len() - notes.len();
    Ok((VaultData { timelines, notes, tombstones }, skipped))
}

/// Rewrite the record folders to exactly match `data`.
pub fn write_tree(dir: &Path, data: &VaultData) -> Result<(), String> {
    fn write_all<T: Serialize>(dir: &Path, items: &[T], id: impl Fn(&T) -> &str) -> Result<(), String> {
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        for it in items {
            if !db::valid_id(id(it)) {
                return Err(format!("Refusing to write a record with id {:?}", id(it)));
            }
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

fn read_rev(dir: &Path, rev: &str) -> Result<(VaultData, usize), String> {
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
    let (remote, skipped) = match &remote_head {
        Some(rev) => read_rev(dir, rev)?,
        None => (VaultData::default(), 0),
    };
    let base = git::base_commit(dir).and_then(|rev| read_rev(dir, &rev).ok()).map(|(v, _)| v);

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
        (summary(incoming, conflicts, skipped), committed)
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

fn summary(incoming: i64, conflicts: usize, skipped: usize) -> String {
    let s = |n: i64| if n.abs() == 1 { "" } else { "s" };
    let mut out = match incoming {
        0 => "Up to date".to_string(),
        n if n > 0 => format!("{n} note{} received", s(n)),
        n => format!("{} note{} removed", -n, s(n)),
    };
    if conflicts > 0 {
        out += &format!(" · {conflicts} conflict cop{} kept", if conflicts == 1 { "y" } else { "ies" });
    }
    if skipped > 0 {
        out += &format!(" · {skipped} invalid record{} skipped", if skipped == 1 { "" } else { "s" });
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

    #[test]
    fn a_hostile_remote_cannot_write_outside_the_vault_or_stall_sync() {
        let root = Tmp(std::env::temp_dir().join(format!("timeline-sync-{}", db::generate_id())));
        let remote = root.0.join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        Command::new("git").args(["init", "--bare", "-q", "-b", "main"]).arg(&remote).output().unwrap();
        let remote = remote.to_string_lossy().to_string();

        // Someone with push access plants records the app would never write itself.
        let evil = root.0.join("evil");
        git::ensure_repo(&evil, &remote).unwrap();
        std::fs::create_dir_all(evil.join("notes")).unwrap();
        let rec = |id: &str, year: i64| format!(r#"{{"id":"{id}","timelineId":"master","title":"x","year":{year}}}"#);
        std::fs::write(evil.join("notes/a.json"), rec("../../../escape", 1)).unwrap();
        std::fs::write(evil.join("notes/b.json"), rec("year-zero", 0)).unwrap();
        std::fs::write(evil.join("notes/c.json"), rec("fine", 1)).unwrap();
        git::commit_all(&evil, "plant", None).unwrap();
        git::push(&evil).unwrap();

        let a = Device::new(&root.0, "a", &remote);
        assert_eq!(a.sync(), "1 note received · 2 invalid records skipped");
        assert_eq!(a.titles(), ["x"], "only the valid note came in");
        // notes/ -> vault/ -> a/ -> root/: where the planted id would have landed.
        assert!(!root.0.join("escape.json").exists());
        assert_eq!(a.sync(), "Up to date", "and the bad records are gone from the remote");
    }

    #[test]
    fn remote_links_are_checked_before_reaching_git() {
        for bad in ["-oProxyCommand=x", "ext::sh -c touch% /tmp/x", "https://u:ghp_x@github.com/o/r.git", "https://ghp_x@github.com/o/r.git"] {
            assert!(check_remote(bad).is_err(), "{bad} must be rejected");
        }
        for ok in ["", "https://github.com/o/r.git", "ssh://git@github.com/o/r.git", "git@github.com:o/r.git", "/tmp/remote.git", "file:///tmp/r.git"] {
            assert!(check_remote(ok).is_ok(), "{ok} must be accepted");
        }
    }
}
