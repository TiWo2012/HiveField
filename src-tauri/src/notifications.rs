//! Notifications: native desktop notifications (via the Tauri notification
//! plugin) and push notifications via ntfy (https://ntfy.sh or a self-hosted
//! instance).
//!
//! The frontend decides *when* to notify (an agent session finished) and
//! invokes [`notify_desktop`] / [`ntfy_send`] with a title and body. The ntfy
//! endpoint, topic and optional access-token auth are read from the settings
//! store (see `settings.rs`); the keys are written by the settings page:
//!
//!   - `ntfyEnabled`: master switch (disabled → `ntfy_send` is a no-op)
//!   - `ntfyServer`:  base URL, e.g. `https://ntfy.sh` or `https://ntfy.example.com`
//!   - `ntfyTopic`:   topic to publish to (a phone subscribed to this topic
//!                    receives the push)
//!   - `ntfyToken`:   optional ntfy access token, sent as `Authorization: Bearer`.
//!                    Stored in plaintext in `settings.json`, exactly as the
//!                    user configured it.

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
/// Reads `ntfyEnabled` / `ntfyServer` / `ntfyTopic` / `ntfyToken` from the
/// settings store. The message is sent as the raw request body with the title
/// and tag carried in `X-Title` / `X-Tags` headers (ntfy's format for
/// publishing to a topic path; a JSON body to a topic path would be stored
/// verbatim as the message). Returns `Ok(())` without sending when ntfy is
/// disabled; errors when the server or topic is missing or the HTTP request
/// fails (non-2xx status included).
#[tauri::command]
pub fn ntfy_send(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
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
    let token = str_setting("ntfyToken");

    let url = format!("{}/{}", server.trim_end_matches('/'), topic);

    let mut request = ureq::post(&url)
        .header("X-Title", &title)
        .header("X-Tags", "computer")
        // ureq 2's send_string() set this implicitly; keep the wire format stable.
        .header("Content-Type", "text/plain; charset=utf-8");
    if !token.is_empty() {
        request = request.header("Authorization", &format!("Bearer {token}"));
    }

    let response = request
        .send(&body)
        .map_err(|e| format!("ntfy request failed: {e}"))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("ntfy server responded with status {status}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
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
