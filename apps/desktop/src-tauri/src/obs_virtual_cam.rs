//! OBS Virtual Camera 整合 — 透過 OBS WebSocket v5 協定控制
//!
//! 自動設定 OBS：建立場景 → 視窗擷取 Avatar 視窗 → 啟動虛擬鏡頭
//! 使用者只需打開 OBS Studio，其餘全自動。

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// OBS WebSocket 連線封裝（一次性使用：連接 → 設定 → 關閉）
struct ObsConnection {
    write: futures_util::stream::SplitSink<WsStream, Message>,
    read: futures_util::stream::SplitStream<WsStream>,
    request_counter: u32,
}

impl ObsConnection {
    /// 連接 OBS WebSocket 並完成認證
    async fn connect(password: Option<&str>) -> Result<Self, String> {
        let (ws_stream, _) = tokio_tungstenite::connect_async("ws://localhost:4455")
            .await
            .map_err(|_| {
                "無法連接 OBS WebSocket。\n請確認：\n1. OBS Studio 已開啟\n2. 工具 → WebSocket 伺服器設定 → 啟用"
                    .to_string()
            })?;

        let (mut write, mut read) = ws_stream.split();

        // 接收 Hello (op: 0)
        let hello = Self::recv_json(&mut read).await?;
        if hello["op"].as_i64() != Some(0) {
            return Err("OBS WebSocket 協定錯誤：未收到 Hello".to_string());
        }

        // 建立 Identify 訊息 (op: 1)
        let identify = if hello["d"]["authentication"].is_object() {
            let auth = &hello["d"]["authentication"];
            let challenge = auth["challenge"].as_str().unwrap_or("");
            let salt = auth["salt"].as_str().unwrap_or("");
            let auth_string = Self::generate_auth(password.unwrap_or(""), challenge, salt);
            json!({ "op": 1, "d": { "rpcVersion": 1, "authentication": auth_string } })
        } else {
            json!({ "op": 1, "d": { "rpcVersion": 1 } })
        };

        write
            .send(Message::Text(identify.to_string()))
            .await
            .map_err(|e| format!("發送認證失敗: {}", e))?;

        // 接收 Identified (op: 2)
        let identified = Self::recv_json(&mut read).await?;
        if identified["op"].as_i64() != Some(2) {
            return Err("OBS 認證失敗，請檢查 WebSocket 密碼".to_string());
        }

        Ok(Self {
            write,
            read,
            request_counter: 0,
        })
    }

    /// 發送 OBS 請求並等待回應
    async fn request(&mut self, request_type: &str, data: Value) -> Result<Value, String> {
        self.request_counter += 1;
        let request_id = format!("r{}", self.request_counter);

        let msg = json!({
            "op": 6,
            "d": {
                "requestType": request_type,
                "requestId": request_id,
                "requestData": data
            }
        });

        self.write
            .send(Message::Text(msg.to_string()))
            .await
            .map_err(|e| format!("發送 OBS 請求失敗: {}", e))?;

        // 等待 RequestResponse (op: 7)，跳過 Event (op: 5) 訊息
        loop {
            let resp = Self::recv_json(&mut self.read).await?;
            if resp["op"].as_i64() == Some(7) {
                return Ok(resp["d"].clone());
            }
            // 其他訊息（Event 等），繼續等待
        }
    }

    /// 關閉連線
    async fn close(mut self) {
        let _ = self.write.close().await;
    }

    /// 接收並解析 JSON
    async fn recv_json(
        read: &mut futures_util::stream::SplitStream<WsStream>,
    ) -> Result<Value, String> {
        let msg = read
            .next()
            .await
            .ok_or("OBS 連線中斷")?
            .map_err(|e| format!("接收失敗: {}", e))?;

        match msg {
            Message::Text(text) => {
                serde_json::from_str(&text).map_err(|e| format!("JSON 解析失敗: {}", e))
            }
            Message::Close(_) => Err("OBS 關閉了連線".to_string()),
            _ => Err("收到非預期的訊息類型".to_string()),
        }
    }

    /// 產生 OBS WebSocket v5 認證字串
    fn generate_auth(password: &str, challenge: &str, salt: &str) -> String {
        use base64::Engine;
        use sha2::{Digest, Sha256};

        // SHA256(password + salt) → base64
        let mut hasher = Sha256::new();
        hasher.update(password.as_bytes());
        hasher.update(salt.as_bytes());
        let secret = base64::engine::general_purpose::STANDARD.encode(hasher.finalize());

        // SHA256(base64_secret + challenge) → base64
        let mut hasher2 = Sha256::new();
        hasher2.update(secret.as_bytes());
        hasher2.update(challenge.as_bytes());
        base64::engine::general_purpose::STANDARD.encode(hasher2.finalize())
    }
}

/// 連接 OBS 並自動設定虛擬鏡頭
pub async fn setup_virtual_camera(
    password: Option<String>,
    avatar_window_title: &str,
) -> Result<String, String> {
    let mut conn = ObsConnection::connect(password.as_deref()).await?;

    let scene_name = "AI Avatar";
    let source_name = "AI Avatar Camera";

    // 1. 建立場景（已存在會回傳錯誤，忽略即可）
    let _ = conn
        .request("CreateScene", json!({ "sceneName": scene_name }))
        .await;

    // 2. 切換到 AI Avatar 場景
    conn.request(
        "SetCurrentProgramScene",
        json!({ "sceneName": scene_name }),
    )
    .await?;

    // 3. 嘗試建立 Browser Source（如果已存在就更新設定）
    let browser_settings = json!({
        "url": "http://127.0.0.1:19280",
        "width": 640,
        "height": 480,
        "css": "",
        "shutdown": false,
        "restart_when_active": false
    });

    let create_result = conn.request(
        "CreateInput",
        json!({
            "sceneName": scene_name,
            "inputName": source_name,
            "inputKind": "browser_source",
            "inputSettings": browser_settings
        }),
    )
    .await;

    if create_result.is_err() {
        // 已存在，更新設定即可
        let _ = conn.request(
            "SetInputSettings",
            json!({
                "inputName": source_name,
                "inputSettings": browser_settings
            }),
        ).await;
    }

    // 4. 強制 Browser Source 重新載入（確保內容最新）
    let _ = conn
        .request(
            "PressInputPropertiesButton",
            json!({ "inputName": source_name, "propertyName": "refreshnocache" }),
        )
        .await;

    // 6. 啟動虛擬鏡頭（可能已經在跑，忽略錯誤）
    let _ = conn.request("StartVirtualCam", json!({})).await;

    // 關閉 WebSocket 連線（虛擬鏡頭會繼續運行）
    conn.close().await;

    Ok("虛擬鏡頭已啟動 — 在視訊軟體選擇「OBS Virtual Camera」作為鏡頭".to_string())
}

/// 停止 OBS 虛擬鏡頭
pub async fn stop_virtual_camera(password: Option<String>) -> Result<String, String> {
    let mut conn = match ObsConnection::connect(password.as_deref()).await {
        Ok(c) => c,
        Err(_) => return Ok("OBS 未連接".to_string()),
    };

    let _ = conn.request("StopVirtualCam", json!({})).await;
    conn.close().await;

    Ok("虛擬鏡頭已停止".to_string())
}

/// 檢查 OBS WebSocket 是否可連線（供 obs_manager 使用）
pub async fn check_websocket_available() -> bool {
    match tokio_tungstenite::connect_async("ws://127.0.0.1:4455").await {
        Ok((ws_stream, _)) => {
            let (mut write, _) = ws_stream.split();
            let _ = write.close().await;
            true
        }
        Err(_) => false,
    }
}
