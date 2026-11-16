mod db;
mod git;
mod merge;
mod sync;

use db::{Note, Timeline};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

struct AppState {
    db: Mutex<Connection>,
    dir: PathBuf,
}

type Res<T> = Result<T, String>;

fn with<T>(s: &State<AppState>, f: impl FnOnce(&mut Connection) -> Res<T>) -> Res<T> {
    let mut conn = s.db.lock().map_err(|e| e.to_string())?;
    f(&mut conn)
}

fn e(err: rusqlite::Error) -> String {
    err.to_string()
}

#[tauri::command]
fn list_timelines(s: State<AppState>) -> Res<Vec<Timeline>> {
    with(&s, |c| db::list_timelines(c).map_err(e))
}

#[tauri::command]
fn save_timeline(s: State<AppState>, mut timeline: Timeline) -> Res<Timeline> {
    if timeline.name.trim().is_empty() {
        return Err("A timeline needs a name".into());
    }
    let now = db::now();
    if timeline.id.is_empty() {
        timeline.id = db::generate_id();
        timeline.created_at = now.clone();
    }
    timeline.modified_at = now;
    with(&s, |c| db::save_timeline(c, &timeline).map_err(e))?;
    Ok(timeline)
}

#[tauri::command]
fn delete_timeline(s: State<AppState>, id: String) -> Res<()> {
    with(&s, |c| db::delete_timeline(c, &id))
}

#[tauri::command]
fn list_notes(s: State<AppState>, timeline_id: String) -> Res<Vec<Note>> {
    with(&s, |c| db::list_notes(c, &timeline_id).map_err(e))
}

/// Every note in every timeline — for the activity heat map.
#[tauri::command]
fn all_notes(s: State<AppState>) -> Res<Vec<Note>> {
    with(&s, |c| db::all_notes(c).map_err(e))
}

#[tauri::command]
fn save_note(s: State<AppState>, mut note: Note) -> Res<Note> {
    db::validate(&note)?;
    let now = db::now();
    if note.id.is_empty() {
        note.id = db::generate_id();
        note.created_at = now.clone();
    }
    note.modified_at = now;
    with(&s, |c| db::save_note(c, &note).map_err(e))?;
    Ok(note)
}

#[tauri::command]
fn delete_note(s: State<AppState>, id: String) -> Res<()> {
    with(&s, |c| db::delete_note(c, &id).map_err(e))
}

#[tauri::command]
fn get_settings(s: State<AppState>) -> Res<std::collections::HashMap<String, String>> {
    with(&s, |c| Ok(db::all_settings(c).map_err(e)?.into_iter().collect()))
}

#[tauri::command]
fn set_setting(s: State<AppState>, key: String, value: String) -> Res<()> {
    if key.starts_with("sync_") {
        return Err("Sync settings are changed through sync_configure".into());
    }
    with(&s, |c| db::set_setting(c, &key, &value).map_err(e))
}

#[tauri::command]
fn export_timeline(s: State<AppState>, id: String, path: String) -> Res<()> {
    with(&s, |c| db::export_to_file(c, &id, std::path::Path::new(&path)))
}

#[tauri::command]
fn import_timeline(s: State<AppState>, path: String) -> Res<Timeline> {
    with(&s, |c| db::import_from_file(c, std::path::Path::new(&path)))
}

#[tauri::command]
fn sync_status(s: State<AppState>) -> Res<sync::SyncStatus> {
    with(&s, |c| Ok(sync::status(c)))
}

#[tauri::command]
fn sync_configure(s: State<AppState>, remote: String) -> Res<()> {
    with(&s, |c| sync::configure(c, &s.dir, &remote))
}

/// Async so the network round-trips run off the main thread.
#[tauri::command]
async fn sync_now(s: State<'_, AppState>) -> Res<String> {
    sync::sync_now(&s.db, &s.dir)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = Connection::open(dir.join("timeline.db"))?;
            db::init(&conn)?;
            app.manage(AppState { db: Mutex::new(conn), dir });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_timelines,
            save_timeline,
            delete_timeline,
            list_notes,
            all_notes,
            save_note,
            delete_note,
            get_settings,
            set_setting,
            export_timeline,
            import_timeline,
            sync_status,
            sync_configure,
            sync_now,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
