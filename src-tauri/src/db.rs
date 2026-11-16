//! SQLite storage: timelines, notes, device settings and deletion tombstones.
//!
//! The database is the source of truth on each device. Sync (`sync.rs`) projects
//! it to JSON files in a git repo and merges other devices' changes back in.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Timeline {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub modified_at: String,
}

/// A dated note. `year` is historical: 1 BCE is -1 and there is no year 0.
/// Everything finer than the year is optional, for works only dated by year.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Note {
    pub id: String,
    pub timeline_id: String,
    pub title: String,
    pub author: String,
    pub year: i64,
    pub month: Option<u8>,
    pub day: Option<u8>,
    pub hour: Option<u8>,
    pub minute: Option<u8>,
    pub body: String,
    /// A pinned card sits at (offset_x, offset_y) px from its date on the axis;
    /// an unpinned one is placed automatically.
    pub pinned: bool,
    pub offset_x: f64,
    pub offset_y: f64,
    pub created_at: String,
    pub modified_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tombstone {
    pub entity: String,
    pub id: String,
    pub deleted_at: String,
}

/// UTC with fixed millisecond precision, so timestamps compare correctly as strings.
/// The Master timeline always exists and cannot be deleted. Its timestamps are
/// fixed so every device seeds an identical record and sync sees no difference.
pub const MASTER_ID: &str = "master";
const EPOCH: &str = "1970-01-01T00:00:00.000Z";

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn generate_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS timelines (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             created_at TEXT NOT NULL,
             modified_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS notes (
             id TEXT PRIMARY KEY,
             timeline_id TEXT NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,
             title TEXT NOT NULL,
             author TEXT NOT NULL DEFAULT '',
             year INTEGER NOT NULL CHECK (year != 0),
             month INTEGER, day INTEGER, hour INTEGER, minute INTEGER,
             body TEXT NOT NULL DEFAULT '',
             pinned INTEGER NOT NULL DEFAULT 0,
             offset_x REAL NOT NULL DEFAULT 0,
             offset_y REAL NOT NULL DEFAULT 0,
             created_at TEXT NOT NULL,
             modified_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS notes_timeline ON notes(timeline_id);
         CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS tombstones (
             entity TEXT NOT NULL, id TEXT NOT NULL, deleted_at TEXT NOT NULL,
             PRIMARY KEY (entity, id)
         );",
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO timelines (id, name, created_at, modified_at) VALUES (?1, 'Master', ?2, ?2)",
        params![MASTER_ID, EPOCH],
    )?;
    Ok(())
}

/// Reject notes the timeline cannot place. This is the trust boundary for both
/// the UI and imported files.
pub fn validate(n: &Note) -> Result<(), String> {
    if n.title.trim().is_empty() {
        return Err("A note needs a title".into());
    }
    if n.year == 0 {
        return Err("There is no year 0 — use 1 AD or 1 BCE".into());
    }
    if n.year.abs() > 1_000_000_000_000 {
        return Err("Years are limited to a trillion either way".into());
    }
    if n.day.is_some() && n.month.is_none() {
        return Err("A day needs a month".into());
    }
    if n.month.is_some_and(|m| !(1..=12).contains(&m))
        || n.day.is_some_and(|d| !(1..=31).contains(&d))
        || n.hour.is_some_and(|h| h > 23)
        || n.minute.is_some_and(|m| m > 59)
    {
        return Err("That date or time is out of range".into());
    }
    if !n.offset_x.is_finite() || !n.offset_y.is_finite() {
        return Err("Invalid card position".into());
    }
    Ok(())
}

// ------------------------------------------------------------------ timelines

fn row_timeline(r: &rusqlite::Row) -> rusqlite::Result<Timeline> {
    Ok(Timeline {
        id: r.get(0)?,
        name: r.get(1)?,
        created_at: r.get(2)?,
        modified_at: r.get(3)?,
    })
}

pub fn list_timelines(conn: &Connection) -> rusqlite::Result<Vec<Timeline>> {
    let mut st = conn.prepare(
        "SELECT id, name, created_at, modified_at FROM timelines ORDER BY created_at, id",
    )?;
    st.query_map([], row_timeline)?.collect()
}

pub fn save_timeline(conn: &Connection, t: &Timeline) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO timelines (id, name, created_at, modified_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, modified_at = excluded.modified_at",
        params![t.id, t.name, t.created_at, t.modified_at],
    )?;
    Ok(())
}

/// Delete a timeline and its notes, leaving tombstones so sync propagates it.
pub fn delete_timeline(conn: &mut Connection, id: &str) -> Result<(), String> {
    if id == MASTER_ID {
        return Err("The Master timeline can't be deleted".into());
    }
    let at = now();
    let run = |tx: &rusqlite::Transaction| -> rusqlite::Result<()> {
        tx.execute(
            "INSERT OR REPLACE INTO tombstones (entity, id, deleted_at)
             SELECT 'note', id, ?2 FROM notes WHERE timeline_id = ?1",
            params![id, at],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO tombstones (entity, id, deleted_at) VALUES ('timeline', ?1, ?2)",
            params![id, at],
        )?;
        tx.execute("DELETE FROM timelines WHERE id = ?1", [id])?;
        Ok(())
    };
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    run(&tx).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------- notes

const NOTE_COLS: &str = "id, timeline_id, title, author, year, month, day, hour, minute, body,
     pinned, offset_x, offset_y, created_at, modified_at";

fn row_note(r: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        timeline_id: r.get(1)?,
        title: r.get(2)?,
        author: r.get(3)?,
        year: r.get(4)?,
        month: r.get(5)?,
        day: r.get(6)?,
        hour: r.get(7)?,
        minute: r.get(8)?,
        body: r.get(9)?,
        pinned: r.get(10)?,
        offset_x: r.get(11)?,
        offset_y: r.get(12)?,
        created_at: r.get(13)?,
        modified_at: r.get(14)?,
    })
}

pub fn list_notes(conn: &Connection, timeline_id: &str) -> rusqlite::Result<Vec<Note>> {
    let mut st = conn.prepare(&format!(
        "SELECT {NOTE_COLS} FROM notes WHERE timeline_id = ?1 ORDER BY year, month, day, id"
    ))?;
    st.query_map([timeline_id], row_note)?.collect()
}

pub fn all_notes(conn: &Connection) -> rusqlite::Result<Vec<Note>> {
    let mut st = conn.prepare(&format!("SELECT {NOTE_COLS} FROM notes ORDER BY id"))?;
    st.query_map([], row_note)?.collect()
}

pub fn save_note(conn: &Connection, n: &Note) -> rusqlite::Result<()> {
    conn.execute(
        &format!(
            "INSERT OR REPLACE INTO notes ({NOTE_COLS})
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"
        ),
        params![
            n.id, n.timeline_id, n.title, n.author, n.year, n.month, n.day, n.hour, n.minute,
            n.body, n.pinned, n.offset_x, n.offset_y, n.created_at, n.modified_at
        ],
    )?;
    Ok(())
}

pub fn delete_note(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO tombstones (entity, id, deleted_at) VALUES ('note', ?1, ?2)",
        params![id, now()],
    )?;
    conn.execute("DELETE FROM notes WHERE id = ?1", [id])?;
    Ok(())
}

// ------------------------------------------------------------------- settings

pub fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

pub fn all_settings(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut st = conn.prepare("SELECT key, value FROM settings")?;
    st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()
}

// ----------------------------------------------------------------- tombstones

pub fn list_tombstones(conn: &Connection) -> rusqlite::Result<Vec<Tombstone>> {
    let mut st = conn.prepare("SELECT entity, id, deleted_at FROM tombstones ORDER BY entity, id")?;
    st.query_map([], |r| {
        Ok(Tombstone {
            entity: r.get(0)?,
            id: r.get(1)?,
            deleted_at: r.get(2)?,
        })
    })?
    .collect()
}

/// Replace all synced content with a merged result, in one transaction.
pub fn replace_all(
    conn: &mut Connection,
    timelines: &[Timeline],
    notes: &[Note],
    tombstones: &[Tombstone],
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch("DELETE FROM notes; DELETE FROM timelines; DELETE FROM tombstones;")?;
    for t in timelines {
        save_timeline(&tx, t)?;
    }
    for n in notes {
        // A note whose timeline was deleted elsewhere has nowhere to live.
        if timelines.iter().any(|t| t.id == n.timeline_id) {
            save_note(&tx, n)?;
        }
    }
    for s in tombstones {
        tx.execute(
            "INSERT OR REPLACE INTO tombstones (entity, id, deleted_at) VALUES (?1, ?2, ?3)",
            params![s.entity, s.id, s.deleted_at],
        )?;
    }
    tx.commit()
}

// ------------------------------------------------------------- export/import

/// The file format for sharing one timeline with someone else.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineExport {
    pub format: String,
    pub version: u32,
    pub timeline: Timeline,
    pub notes: Vec<Note>,
}

pub const EXPORT_FORMAT: &str = "timeline-app";

pub fn export_timeline(conn: &Connection, id: &str) -> Result<TimelineExport, String> {
    let timeline = list_timelines(conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or("Timeline not found")?;
    let notes = list_notes(conn, id).map_err(|e| e.to_string())?;
    Ok(TimelineExport {
        format: EXPORT_FORMAT.into(),
        version: 1,
        timeline,
        notes,
    })
}

/// Import a shared timeline as a new copy with fresh ids, so importing the same
/// file twice never overwrites anything. Links are by title, so they survive.
pub fn import_timeline(conn: &mut Connection, json: &str) -> Result<Timeline, String> {
    let data: TimelineExport =
        serde_json::from_str(json).map_err(|e| format!("Not a timeline file: {e}"))?;
    if data.format != EXPORT_FORMAT {
        return Err("Not a timeline file".into());
    }
    for n in &data.notes {
        validate(n).map_err(|e| format!("{}: {e}", n.title))?;
    }
    let at = now();
    // Keep names distinct, e.g. importing your own "Master" export.
    let taken: Vec<String> = list_timelines(conn).map_err(|e| e.to_string())?.into_iter().map(|t| t.name).collect();
    let mut name = data.timeline.name.trim().to_string();
    if name.is_empty() {
        name = "Imported timeline".into();
    }
    if taken.contains(&name) {
        name = format!("{name} (imported)");
        let base = name.clone();
        let mut n = 2;
        while taken.contains(&name) {
            name = format!("{base} {n}");
            n += 1;
        }
    }
    let timeline = Timeline {
        id: generate_id(),
        name,
        created_at: at.clone(),
        modified_at: at.clone(),
    };
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    save_timeline(&tx, &timeline).map_err(|e| e.to_string())?;
    for n in data.notes {
        let note = Note {
            id: generate_id(),
            timeline_id: timeline.id.clone(),
            modified_at: at.clone(),
            ..n
        };
        save_note(&tx, &note).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(timeline)
}

/// Write one timeline to a shareable `.json` file.
pub fn export_to_file(conn: &Connection, id: &str, path: &std::path::Path) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&export_timeline(conn, id)?).map_err(|e| e.to_string())?;
    std::fs::write(path, json + "\n").map_err(|e| format!("Couldn't write {}: {e}", path.display()))
}

/// Read a shared `.json` file into a new timeline.
pub fn import_from_file(conn: &mut Connection, path: &std::path::Path) -> Result<Timeline, String> {
    let json = std::fs::read_to_string(path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
    import_timeline(conn, &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c
    }

    #[test]
    fn export_then_import_makes_an_independent_copy() {
        let mut c = mem();
        let t = Timeline { id: "t".into(), name: "Greeks".into(), ..Default::default() };
        save_timeline(&c, &t).unwrap();
        let n = Note {
            id: "n".into(),
            timeline_id: "t".into(),
            title: "Republic".into(),
            year: -375,
            ..Default::default()
        };
        save_note(&c, &n).unwrap();

        let json = serde_json::to_string(&export_timeline(&c, "t").unwrap()).unwrap();
        let copy = import_timeline(&mut c, &json).unwrap();
        import_timeline(&mut c, &json).unwrap();

        assert_eq!(list_timelines(&c).unwrap().len(), 4, "master + original + two copies");
        let names: Vec<String> = list_timelines(&c).unwrap().into_iter().map(|t| t.name).collect();
        assert!(names.contains(&"Greeks (imported)".to_string()) && names.contains(&"Greeks (imported) 2".to_string()), "{names:?}");
        let notes = list_notes(&c, &copy.id).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!((notes[0].title.as_str(), notes[0].year), ("Republic", -375));
        assert_ne!(notes[0].id, "n");
    }

    #[test]
    fn a_timeline_file_moves_between_two_people() {
        let dir = std::env::temp_dir().join(format!("timeline-share-{}", generate_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Greeks.timeline.json");

        let alice = mem();
        save_timeline(&alice, &Timeline { id: "t".into(), name: "Greeks".into(), ..Default::default() }).unwrap();
        let n = Note {
            id: "n".into(),
            timeline_id: "t".into(),
            title: "Politics".into(),
            author: "Aristotle".into(),
            year: -350,
            body: "Answers [[The Republic]].".into(),
            pinned: true,
            offset_x: -120.0,
            offset_y: -300.0,
            ..Default::default()
        };
        save_note(&alice, &n).unwrap();
        export_to_file(&alice, "t", &file).unwrap();

        let mut bob = mem();
        let t = import_from_file(&mut bob, &file).unwrap();
        assert_eq!(t.name, "Greeks");
        let got = &list_notes(&bob, &t.id).unwrap()[0];
        assert_eq!((got.title.as_str(), got.author.as_str(), got.year), ("Politics", "Aristotle", -350));
        assert_eq!(got.body, n.body, "links survive");
        assert!(got.pinned && got.offset_x == -120.0 && got.offset_y == -300.0, "card placement survives");

        assert!(import_from_file(&mut bob, &dir.join("missing.json")).unwrap_err().contains("Couldn't read"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn import_rejects_bad_files() {
        let mut c = mem();
        assert!(import_timeline(&mut c, "{}").is_err());
        let bad = r#"{"format":"timeline-app","version":1,"timeline":{"name":"x"},
                     "notes":[{"title":"Zero","year":0}]}"#;
        assert!(import_timeline(&mut c, bad).is_err());
        let deep = |year| Note { title: "x".into(), year, ..Default::default() };
        assert!(validate(&deep(-13_787_000_000)).is_ok(), "the Big Bang is a valid date");
        assert!(validate(&deep(-2_000_000_000_000)).is_err());
        assert_eq!(list_timelines(&c).unwrap().len(), 1, "nothing half-imported");
    }

    #[test]
    fn deleting_a_timeline_tombstones_its_notes() {
        let mut c = mem();
        save_timeline(&c, &Timeline { id: "t".into(), name: "x".into(), ..Default::default() })
            .unwrap();
        save_note(&c, &Note { id: "n".into(), timeline_id: "t".into(), title: "a".into(), year: 1, ..Default::default() })
            .unwrap();
        delete_timeline(&mut c, "t").unwrap();
        assert!(delete_timeline(&mut c, MASTER_ID).is_err(), "master is permanent");
        assert!(all_notes(&c).unwrap().is_empty());
        assert_eq!(list_tombstones(&c).unwrap().len(), 2);
    }
}
