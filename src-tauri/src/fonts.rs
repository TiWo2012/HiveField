/// IPC command: enumerate every font family installed on the system.
///
/// Returns sorted, deduplicated family names. Never panics; on any failure it
/// returns an empty Vec.
#[tauri::command]
pub fn list_system_fonts() -> Vec<String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    let families = db.faces().flat_map(|face| {
        face.families
            .iter()
            .map(|(name, _)| name.clone())
    });

    normalize(families)
}

/// Pure helper: trim names, drop empties, dedupe case-insensitively, then sort
/// case-insensitively.
fn normalize(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for name in names {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let key = name.to_lowercase();
        if seen.iter().any(|s| s.to_lowercase() == key) {
            continue;
        }
        seen.push(name.to_string());
    }
    seen.sort_by_key(|s| s.to_lowercase());
    seen
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_yields_empty_result() {
        let names: Vec<String> = Vec::new();
        assert!(normalize(names).is_empty());
    }

    #[test]
    fn trims_whitespace_and_drops_empties() {
        let names = vec![
            "  Arial  ".to_string(),
            "".to_string(),
            "   ".to_string(),
            "DejaVu Sans".to_string(),
        ];
        assert_eq!(normalize(names), vec!["Arial", "DejaVu Sans"]);
    }

    #[test]
    fn dedupes_exact_duplicates() {
        let names = vec![
            "Arial".to_string(),
            "Arial".to_string(),
            "DejaVu Sans".to_string(),
            "DejaVu Sans".to_string(),
        ];
        assert_eq!(normalize(names), vec!["Arial", "DejaVu Sans"]);
    }

    #[test]
    fn dedupes_case_insensitively() {
        let names = vec![
            "Arial".to_string(),
            "ARIAL".to_string(),
            "ariaL".to_string(),
            "DejaVu Sans".to_string(),
        ];
        assert_eq!(normalize(names), vec!["Arial", "DejaVu Sans"]);
    }

    #[test]
    fn sorts_case_insensitively() {
        let names = vec![
            "Zebra".to_string(),
            "alpha".to_string(),
            "Beta".to_string(),
            "mango".to_string(),
        ];
        assert_eq!(normalize(names), vec!["alpha", "Beta", "mango", "Zebra"]);
    }
}
