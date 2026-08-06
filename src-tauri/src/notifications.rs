//! Notifications: native desktop notifications (via the Tauri notification
//! plugin) and push notifications via ntfy (https://ntfy.sh or a self-hosted
//! instance).
//!
//! The frontend decides *when* to notify (an agent session finished) and
//! invokes [`notify_desktop`] / [`ntfy_send`] with a title and body. The ntfy
//! endpoint, topic and optional Basic-auth credentials are read from the
//! settings store (see `settings.rs`); the keys are written by the settings
//! page:
//!
//!   - `ntfyEnabled`: master switch (disabled → `ntfy_send` is a no-op)
//!   - `ntfyServer`:  base URL, e.g. `https://ntfy.sh` or `https://ntfy.example.com`
//!   - `ntfyTopic`:   topic to publish to (a phone subscribed to this topic
//!                    receives the push)
//!   - `ntfyUser` / `ntfyPass`: optional Basic-auth credentials. Stored in
//!     plaintext in `settings.json`, exactly as the user configured them.

use tauri_plugin_notification::NotificationExt;

/// Show a native desktop notification (e.g. "opencode done").
#[tauri::command]
pub fn notify_desktop(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| format!("failed to show desktop notification: {e}"))
}

/// Publish a push notification to the configured ntfy server + topic.
///
/// Reads `ntfyEnabled` / `ntfyServer` / `ntfyTopic` / `ntfyUser` / `ntfyPass`
/// from the settings store. Returns `Ok(())` without sending when ntfy is
/// disabled; errors when the server or topic is missing or the HTTP request
/// fails (non-2xx status included).
#[tauri::command]
pub fn ntfy_send(app: tauri::AppHandle, title: String, message: String) -> Result<(), String> {
    let store = crate::settings::SettingsStore::load(&app)?;
    let settings = store.read();

    let str_setting = |key: &str| -> String {
        settings
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .to_string()
    };

    if !settings
        .get("ntfyEnabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(());
    }

    let server = str_setting("ntfyServer");
    let topic = str_setting("ntfyTopic");
    if server.is_empty() || topic.is_empty() {
        return Err("ntfy is enabled but server or topic is not configured".to_string());
    }
    let user = str_setting("ntfyUser");
    let pass = str_setting("ntfyPass");

    let url = format!("{}/{}", server.trim_end_matches('/'), topic);
    let payload = serde_json::json!({
        "title": title,
        "message": message,
        "tags": ["computer"],
    });

    let mut request = ureq::post(&url).set("Content-Type", "application/json");
    if !user.is_empty() {
        use base64::Engine as _;
        let credentials =
            base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"));
        request = request.set("Authorization", &format!("Basic {credentials}"));
    }

    let response = request
        .send_string(&payload.to_string())
        .map_err(|e| format!("ntfy request failed: {e}"))?;
    let status = response.status();
    if !(200..300).contains(&status) {
        return Err(format!("ntfy server responded with status {status}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build the ntfy publish URL from a configured server + topic (mirrors
    /// the production code path, which reads these from the settings store).
    fn publish_url(server: &str, topic: &str) -> String {
        format!("{}/{}", server.trim_end_matches('/'), topic)
    }

    #[test]
    fn publish_url_joins_server_and_topic() {
        assert_eq!(
            publish_url("https://ntfy.sh", "my-topic"),
            "https://ntfy.sh/my-topic"
        );
    }

    #[test]
    fn publish_url_strips_trailing_slash_from_server() {
        assert_eq!(
            publish_url("https://ntfy.example.com/", "alerts"),
            "https://ntfy.example.com/alerts"
        );
    }
}
