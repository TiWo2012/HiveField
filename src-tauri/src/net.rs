//! Small HTTP client abstraction shared by every place the backend talks to a
//! server directly (ntfy pushes, model downloads, cloud transcription).
//!
//! Wraps `ureq` (v3) behind a typed, configured client: connect/read timeouts,
//! a user agent, and normalized errors, so call sites describe *what* they
//! send instead of hand-building request plumbing. Every response is drained
//! and status-checked here, so an `Err` always means "the request truly
//! failed".

use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

/// Connect timeout for every request.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Read timeout (per request body read) for every request.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// A reusable HTTP client. `ureq::Agent` pools connections, so repeated
/// requests to the same host (e.g. ntfy pushes or retried downloads) do not
/// redo the TLS handshake every time.
#[derive(Clone)]
pub struct HttpClient {
    agent: ureq::Agent,
}

impl Default for HttpClient {
    fn default() -> Self {
        let config = ureq::Agent::config_builder()
            .user_agent(concat!("hivefield/", env!("CARGO_PKG_VERSION")))
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .timeout_recv_body(Some(READ_TIMEOUT))
            .build();
        Self {
            agent: ureq::Agent::new_with_config(config),
        }
    }
}

impl HttpClient {
    /// POST `body` as the raw request body to `url` with the given headers.
    /// Returns the response body on success; `Err` on transport errors or any
    /// non-2xx status (including the server's body in the message).
    pub fn post_text(&self, url: &str, headers: &[(&str, &str)], body: &str) -> Result<String, String> {
        let mut request = self.agent.post(url);
        for &(name, value) in headers {
            request = request.header(name, value);
        }
        let response = request
            .send(body)
            .map_err(|e| format!("POST {url} failed: {e}"))?;
        let status = response.status().as_u16();
        let text = response.into_body().read_to_string().unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(format!("POST {url} returned HTTP {status}: {text}"));
        }
        Ok(text)
    }

    /// POST raw bytes (e.g. a multipart body) with the given headers. Returns
    /// the response body on success; `Err` on transport errors or non-2xx.
    pub fn post_bytes(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<String, String> {
        let mut request = self.agent.post(url);
        for &(name, value) in headers {
            request = request.header(name, value);
        }
        let response = request
            .send(body)
            .map_err(|e| format!("POST {url} failed: {e}"))?;
        let status = response.status().as_u16();
        let text = response.into_body().read_to_string().unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(format!("POST {url} returned HTTP {status}: {text}"));
        }
        Ok(text)
    }

    /// GET `url` and stream the body to `dest`, invoking `on_progress` with the
    /// download percentage (0..=100) whenever it advances. The caller decides
    /// where the file lands and how to finalize partial downloads. `Err` on
    /// transport errors or non-2xx.
    #[allow(dead_code)]
    pub fn get_to_file(
        &self,
        url: &str,
        dest: &Path,
        mut on_progress: impl FnMut(u8),
    ) -> Result<(), String> {
        let response = self
            .agent
            .get(url)
            .call()
            .map_err(|e| format!("GET {url} failed: {e}"))?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(format!("GET {url} returned HTTP {status}"));
        }
        let total: u64 = response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let mut file =
            std::fs::File::create(dest).map_err(|e| format!("failed to create {}: {e}", dest.display()))?;
        let mut reader = response.into_body().into_reader();
        let mut buf = [0u8; 256 * 1024];
        let mut downloaded: u64 = 0;
        let mut last_percent = 0u8;
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|e| format!("download read failed: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])
                .map_err(|e| format!("download write failed: {e}"))?;
            downloaded += n as u64;
            if total > 0 {
                let percent = (downloaded * 100 / total) as u8;
                if percent != last_percent {
                    last_percent = percent;
                    on_progress(percent);
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_constructs_with_defaults() {
        // Constructing the shared client wires up timeouts + a user agent and
        // must never fail.
        let _ = HttpClient::default();
    }
}
