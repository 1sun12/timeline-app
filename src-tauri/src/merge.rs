//! Three-way record merge, ported from Bonfire's design (docs: README → Sync).
//!
//! Pure functions: no database, filesystem or git. `base` is the vault at the
//! last successful sync, `local` this device, `remote` what others published.
//! If only one side moved away from base, take it. If both moved and disagree,
//! the newer `modified_at` wins (ties go to remote, so every device agrees) and
//! a losing note is kept as a "(conflict copy)" note rather than dropped.

use crate::db::{generate_id, Note, Timeline, Tombstone};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct VaultData {
    pub timelines: Vec<Timeline>,
    pub notes: Vec<Note>,
    pub tombstones: Vec<Tombstone>,
}

trait Record: Clone + Serialize {
    const ENTITY: &'static str;
    fn id(&self) -> &str;
    fn modified_at(&self) -> &str;
    /// Content identity ignoring the timestamp: two sides that agree on substance
    /// are not a conflict even if saved a second apart.
    fn content(&self) -> String {
        let mut v = serde_json::to_value(self).unwrap_or_default();
        if let Some(o) = v.as_object_mut() {
            o.remove("modifiedAt");
        }
        v.to_string()
    }
    /// What to keep of a losing edit, if anything.
    fn conflict_copy(&self) -> Option<Self> {
        None
    }
}

impl Record for Timeline {
    const ENTITY: &'static str = "timeline";
    fn id(&self) -> &str {
        &self.id
    }
    fn modified_at(&self) -> &str {
        &self.modified_at
    }
}

impl Record for Note {
    const ENTITY: &'static str = "note";
    fn id(&self) -> &str {
        &self.id
    }
    fn modified_at(&self) -> &str {
        &self.modified_at
    }
    fn conflict_copy(&self) -> Option<Self> {
        Some(Note {
            id: generate_id(),
            title: format!("{} (conflict copy)", self.title),
            ..self.clone()
        })
    }
}

fn merge_records<T: Record>(base: &[T], local: &[T], remote: &[T]) -> (Vec<T>, usize) {
    let index = |rs: &[T]| -> BTreeMap<String, T> {
        rs.iter().map(|r| (r.id().to_string(), r.clone())).collect()
    };
    let (b, l, r) = (index(base), index(local), index(remote));
    let mut ids: Vec<&String> = l.keys().chain(r.keys()).collect();
    ids.sort();
    ids.dedup();

    let mut out = Vec::with_capacity(ids.len());
    let mut conflicts = 0;
    for id in ids {
        match (l.get(id), r.get(id)) {
            (Some(lv), Some(rv)) => {
                let (lc, rc) = (lv.content(), rv.content());
                let based = b.get(id).map(|v| v.content());
                if lc == rc || based.as_deref() == Some(rc.as_str()) {
                    out.push(lv.clone());
                } else if based.as_deref() == Some(lc.as_str()) {
                    out.push(rv.clone());
                } else {
                    let (win, lose) = if lv.modified_at() > rv.modified_at() {
                        (lv, rv)
                    } else {
                        (rv, lv)
                    };
                    out.push(win.clone());
                    if let Some(copy) = lose.conflict_copy() {
                        out.push(copy);
                        conflicts += 1;
                    }
                }
            }
            // One side only: new there, or deleted here. Tombstones decide below.
            (Some(v), None) | (None, Some(v)) => out.push(v.clone()),
            (None, None) => unreachable!(),
        }
    }
    (out, conflicts)
}

/// Drop records buried by a newer tombstone; drop tombstones a later edit overruled.
/// Editing a note after it was deleted elsewhere resurrects it — recovering an
/// unwanted note is one click, recovering a lost one is impossible.
fn apply_tombstones<T: Record>(records: Vec<T>, stones: &mut Vec<Tombstone>) -> Vec<T> {
    let kept: Vec<T> = records
        .into_iter()
        .filter(|rec| {
            !stones.iter().any(|t| {
                t.entity == T::ENTITY && t.id == rec.id() && t.deleted_at.as_str() >= rec.modified_at()
            })
        })
        .collect();
    stones.retain(|t| t.entity != T::ENTITY || !kept.iter().any(|r| r.id() == t.id));
    kept
}

/// Returns the merged vault and how many conflict copies were kept.
pub fn merge(base: Option<&VaultData>, local: &VaultData, remote: &VaultData) -> (VaultData, usize) {
    let empty = VaultData::default();
    let base = base.unwrap_or(&empty);

    let mut stones: BTreeMap<(String, String), Tombstone> = BTreeMap::new();
    for t in local.tombstones.iter().chain(&remote.tombstones) {
        let key = (t.entity.clone(), t.id.clone());
        if stones.get(&key).is_none_or(|e| e.deleted_at < t.deleted_at) {
            stones.insert(key, t.clone());
        }
    }
    let mut stones: Vec<Tombstone> = stones.into_values().collect();

    let (timelines, _) = merge_records(&base.timelines, &local.timelines, &remote.timelines);
    let (notes, conflicts) = merge_records(&base.notes, &local.notes, &remote.notes);
    let timelines = apply_tombstones(timelines, &mut stones);
    let notes = apply_tombstones(notes, &mut stones);
    let notes = notes
        .into_iter()
        .filter(|n| timelines.iter().any(|t| t.id == n.timeline_id))
        .collect();
    (VaultData { timelines, notes, tombstones: stones }, conflicts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tl() -> Timeline {
        Timeline { id: "t".into(), name: "T".into(), ..Default::default() }
    }
    fn note(id: &str, title: &str, at: &str) -> Note {
        Note {
            id: id.into(),
            timeline_id: "t".into(),
            title: title.into(),
            year: 1,
            modified_at: at.into(),
            ..Default::default()
        }
    }
    fn vault(notes: Vec<Note>) -> VaultData {
        VaultData { timelines: vec![tl()], notes, tombstones: vec![] }
    }

    #[test]
    fn one_sided_edit_is_taken_without_conflict() {
        let base = vault(vec![note("a", "old", "1")]);
        let local = vault(vec![note("a", "old", "1")]);
        let remote = vault(vec![note("a", "new", "2")]);
        let (m, c) = merge(Some(&base), &local, &remote);
        assert_eq!((m.notes[0].title.as_str(), c), ("new", 0));
    }

    #[test]
    fn double_edit_keeps_the_newer_and_a_copy_of_the_loser() {
        let base = vault(vec![note("a", "old", "1")]);
        let local = vault(vec![note("a", "mine", "3")]);
        let remote = vault(vec![note("a", "theirs", "2")]);
        let (m, c) = merge(Some(&base), &local, &remote);
        assert_eq!(c, 1);
        let mut titles: Vec<_> = m.notes.iter().map(|n| n.title.as_str()).collect();
        titles.sort();
        assert_eq!(titles, ["mine", "theirs (conflict copy)"]);
    }

    #[test]
    fn delete_wins_over_older_edit_but_loses_to_newer() {
        let stone = |at: &str| Tombstone { entity: "note".into(), id: "a".into(), deleted_at: at.into() };
        let base = vault(vec![note("a", "x", "1")]);
        let mut local = vault(vec![]);
        local.tombstones.push(stone("2"));

        let (m, _) = merge(Some(&base), &local, &vault(vec![note("a", "x", "1")]));
        assert!(m.notes.is_empty(), "deletion propagates");

        let (m, _) = merge(Some(&base), &local, &vault(vec![note("a", "edited", "3")]));
        assert_eq!(m.notes.len(), 1, "a later edit resurrects");
        assert!(m.tombstones.is_empty(), "and the spent tombstone is dropped");
    }

    #[test]
    fn merge_is_order_independent() {
        let base = vault(vec![note("a", "old", "1")]);
        let x = vault(vec![note("a", "x", "3"), note("b", "bx", "1")]);
        let y = vault(vec![note("a", "y", "2"), note("c", "cy", "1")]);
        let titles = |v: &VaultData| {
            let mut t: Vec<String> = v.notes.iter().map(|n| n.title.clone()).collect();
            t.sort();
            t
        };
        assert_eq!(titles(&merge(Some(&base), &x, &y).0), titles(&merge(Some(&base), &y, &x).0));
    }
}
