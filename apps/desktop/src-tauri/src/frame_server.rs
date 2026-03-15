//! 本地 HTTP 伺服器 — 提供 MuseTalk 幀給 OBS Browser Source
//! OBS Browser Source 連到 http://127.0.0.1:19280 即時顯示 AI 唇形動畫

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

/// 儲存最新的 JPEG 幀（MuseTalk 或 face snapshot）
static FRAME_DATA: std::sync::OnceLock<Arc<Mutex<Vec<u8>>>> = std::sync::OnceLock::new();
/// 幀更新計數器（診斷用）
static FRAME_COUNT: AtomicU64 = AtomicU64::new(0);
/// 幀請求計數器（診斷用）
static REQUEST_COUNT: AtomicU64 = AtomicU64::new(0);

fn get_frame_store() -> &'static Arc<Mutex<Vec<u8>>> {
    FRAME_DATA.get_or_init(|| Arc::new(Mutex::new(Vec::new())))
}

/// 更新最新幀（從 base64 JPEG 解碼）
pub async fn update_frame_base64(base64_jpeg: &str) {
    use base64::Engine;
    // 去除可能的 data URI 前綴（data:image/jpeg;base64,）
    let b64 = if let Some(pos) = base64_jpeg.find(",") {
        &base64_jpeg[pos + 1..]
    } else {
        base64_jpeg
    };
    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
        let count = FRAME_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
        if count <= 3 || count % 100 == 0 {
            eprintln!("Frame server: 收到幀 #{} ({}KB)", count, bytes.len() / 1024);
        }
        let store = get_frame_store();
        let mut guard = store.lock().await;
        *guard = bytes;
    } else {
        eprintln!("Frame server: base64 解碼失敗 (len={})", base64_jpeg.len());
    }
}

/// 更新最新幀（從原始 JPEG bytes）
pub async fn update_frame_bytes(jpeg_bytes: Vec<u8>) {
    FRAME_COUNT.fetch_add(1, Ordering::Relaxed);
    let store = get_frame_store();
    let mut guard = store.lock().await;
    *guard = jpeg_bytes;
}

/// OBS Browser Source 用的 HTML 頁面（25 FPS 輪詢最新幀）
/// 含診斷計數器（綠色文字顯示在左下角）
const HTML_PAGE: &str = r#"<!DOCTYPE html>
<html><head><style>
body{margin:0;padding:0;background:#000;overflow:hidden}
img{width:100vw;height:100vh;object-fit:cover;display:block}
#d{position:fixed;bottom:4px;left:4px;color:#0f0;font:bold 14px monospace;z-index:99;text-shadow:0 0 3px #000}
</style></head><body>
<img id="f">
<div id="d">等待幀...</div>
<script>
const img=document.getElementById('f');
const dbg=document.getElementById('d');
let n=0,ok=0,err=0,loading=false;
setInterval(()=>{
  if(loading)return;
  loading=true;
  const tmp=new Image();
  tmp.onload=()=>{img.src=tmp.src;loading=false;ok++;dbg.textContent='幀:'+ok+' 失敗:'+err;};
  tmp.onerror=()=>{loading=false;err++;dbg.textContent='幀:'+ok+' 失敗:'+err;};
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
            let mut buf = [0u8; 4096];
            let n = match stream.read(&mut buf).await {
                Ok(n) if n > 0 => n,
                _ => return,
            };
            let request = String::from_utf8_lossy(&buf[..n]);
            let path = request.split_whitespace().nth(1).unwrap_or("/");

            if path.starts_with("/frame") {
                REQUEST_COUNT.fetch_add(1, Ordering::Relaxed);
                let frame = store.lock().await.clone();
                if frame.is_empty() {
                    let resp = b"HTTP/1.1 204 No Content\r\nConnection: close\r\nCache-Control: no-cache\r\n\r\n";
                    stream.write_all(resp).await.ok();
                } else {
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-cache, no-store\r\nAccess-Control-Allow-Origin: *\r\n\r\n",
                        frame.len()
                    );
                    stream.write_all(header.as_bytes()).await.ok();
                    stream.write_all(&frame).await.ok();
                }
            } else if path.starts_with("/status") {
                // 診斷端點
                let frame_len = store.lock().await.len();
                let body = format!(
                    "{{\"frames_received\":{},\"requests_served\":{},\"current_frame_bytes\":{}}}",
                    FRAME_COUNT.load(Ordering::Relaxed),
                    REQUEST_COUNT.load(Ordering::Relaxed),
                    frame_len,
                );
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(header.as_bytes()).await.ok();
                stream.write_all(body.as_bytes()).await.ok();
            } else {
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-cache\r\n\r\n",
                    HTML_PAGE.len()
                );
                stream.write_all(header.as_bytes()).await.ok();
                stream.write_all(HTML_PAGE.as_bytes()).await.ok();
            }
        });
    }
}
