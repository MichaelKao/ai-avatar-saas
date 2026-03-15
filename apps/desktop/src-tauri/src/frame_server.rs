//! 本地 HTTP 伺服器 — 提供 MuseTalk 幀給 OBS Browser Source
//! OBS Browser Source 連到 http://127.0.0.1:19280 即時顯示 AI 唇形動畫

use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

/// 儲存最新的 JPEG 幀（MuseTalk 或 face snapshot）
static FRAME_DATA: std::sync::OnceLock<Arc<Mutex<Vec<u8>>>> = std::sync::OnceLock::new();

fn get_frame_store() -> &'static Arc<Mutex<Vec<u8>>> {
    FRAME_DATA.get_or_init(|| Arc::new(Mutex::new(Vec::new())))
}

/// 更新最新幀（從 base64 JPEG 解碼）
pub async fn update_frame_base64(base64_jpeg: &str) {
    use base64::Engine;
    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(base64_jpeg) {
        let store = get_frame_store();
        let mut guard = store.lock().await;
        *guard = bytes;
    }
}

/// 更新最新幀（從原始 JPEG bytes）
pub async fn update_frame_bytes(jpeg_bytes: Vec<u8>) {
    let store = get_frame_store();
    let mut guard = store.lock().await;
    *guard = jpeg_bytes;
}

/// OBS Browser Source 用的 HTML 頁面（25 FPS 輪詢最新幀）
const HTML_PAGE: &str = r#"<!DOCTYPE html>
<html><head><style>
body{margin:0;padding:0;background:#000;overflow:hidden}
img{width:100vw;height:100vh;object-fit:cover;display:block}
</style></head><body>
<img id="f">
<script>
const img=document.getElementById('f');
let n=0,loading=false;
setInterval(()=>{
  if(loading)return;
  loading=true;
  const tmp=new Image();
  tmp.onload=()=>{img.src=tmp.src;loading=false;};
  tmp.onerror=()=>{loading=false;};
  tmp.src='/frame?'+(n++);
},40);
</script>
</body></html>"#;

/// 啟動本地 HTTP 伺服器（port 19280）
pub async fn start(port: u16) {
    let listener = match TcpListener::bind(format!("127.0.0.1:{}", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Frame server 啟動失敗 (port {}): {}", port, e);
            return;
        }
    };
    eprintln!("Frame server 啟動在 http://127.0.0.1:{}", port);

    loop {
        let (mut stream, _) = match listener.accept().await {
            Ok(s) => s,
            Err(_) => continue,
        };
        let store = get_frame_store().clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 2048];
            let n = match stream.read(&mut buf).await {
                Ok(n) if n > 0 => n,
                _ => return,
            };
            let request = String::from_utf8_lossy(&buf[..n]);
            let path = request.split_whitespace().nth(1).unwrap_or("/");

            if path.starts_with("/frame") {
                let frame = store.lock().await.clone();
                if frame.is_empty() {
                    let resp = b"HTTP/1.1 204 No Content\r\nCache-Control: no-cache\r\n\r\n";
                    stream.write_all(resp).await.ok();
                } else {
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nCache-Control: no-cache, no-store\r\nAccess-Control-Allow-Origin: *\r\n\r\n",
                        frame.len()
                    );
                    stream.write_all(header.as_bytes()).await.ok();
                    stream.write_all(&frame).await.ok();
                }
            } else {
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-cache\r\n\r\n",
                    HTML_PAGE.len()
                );
                stream.write_all(header.as_bytes()).await.ok();
                stream.write_all(HTML_PAGE.as_bytes()).await.ok();
            }
        });
    }
}
