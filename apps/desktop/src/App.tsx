import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface SessionStatus {
  connected: boolean;
  stt_active: boolean;
  audio_active: boolean;
}

interface Suggestion {
  text: string;
  timestamp: number;
}

function App() {
  const [apiUrl, setApiUrl] = useState('https://ai-avatar-saas-production.up.railway.app');
  const [token, setToken] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [devices, setDevices] = useState<string[]>([]);

  useEffect(() => {
    // 監聽 WebSocket 訊息
    const unlisten1 = listen<string>('ws-message', (event) => {
      try {
        const msg = JSON.parse(event.payload);
        if (msg.type === 'suggestion_text') {
          setSuggestions(prev => [...prev, {
            text: msg.payload?.text || msg.data?.text || '',
            timestamp: Date.now()
          }]);
        }
      } catch (e) {
        console.error('解析訊息失敗', e);
      }
    });

    // 監聽 STT 結果
    const unlisten2 = listen<string>('stt-result', (event) => {
      console.log('STT:', event.payload);
    });

    // 載入音訊裝置
    loadDevices();

    return () => {
      unlisten1.then(fn => fn());
      unlisten2.then(fn => fn());
    };
  }, []);

  const loadDevices = async () => {
    try {
      const devs = await invoke<string[]>('get_audio_devices');
      setDevices(devs);
    } catch (e) {
      console.error('載入裝置失敗', e);
    }
  };

  const startSession = async () => {
    try {
      await invoke('start_session', { apiUrl, token, sessionId });
      setIsRunning(true);
      setSuggestions([]);
    } catch (e) {
      alert('啟動失敗: ' + e);
    }
  };

  const stopSession = async () => {
    try {
      await invoke('stop_session');
      setIsRunning(false);
    } catch (e) {
      alert('停止失敗: ' + e);
    }
  };

  return (
    <div style={{ padding: 20, fontFamily: 'system-ui', maxWidth: 800, margin: '0 auto' }}>
      <h1>AI Avatar Desktop</h1>

      {/* 連線設定 */}
      <div style={{ marginBottom: 20, padding: 16, border: '1px solid #ddd', borderRadius: 8 }}>
        <h3>連線設定</h3>
        <div style={{ marginBottom: 8 }}>
          <label>API URL:</label>
          <input value={apiUrl} onChange={e => setApiUrl(e.target.value)}
                 style={{ width: '100%', padding: 8, marginTop: 4 }} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>Token:</label>
          <input value={token} onChange={e => setToken(e.target.value)}
                 type="password" style={{ width: '100%', padding: 8, marginTop: 4 }} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>Session ID:</label>
          <input value={sessionId} onChange={e => setSessionId(e.target.value)}
                 style={{ width: '100%', padding: 8, marginTop: 4 }} />
        </div>
      </div>

      {/* 音訊裝置 */}
      <div style={{ marginBottom: 20, padding: 16, border: '1px solid #ddd', borderRadius: 8 }}>
        <h3>音訊裝置</h3>
        <select style={{ width: '100%', padding: 8 }}
                onChange={e => invoke('set_audio_device', { deviceName: e.target.value })}>
          <option>選擇麥克風...</option>
          {devices.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      {/* 控制按鈕 */}
      <div style={{ marginBottom: 20 }}>
        {!isRunning ? (
          <button onClick={startSession}
                  style={{ padding: '12px 24px', background: '#3b82f6', color: 'white',
                           border: 'none', borderRadius: 8, fontSize: 16, cursor: 'pointer' }}>
            開始會議
          </button>
        ) : (
          <button onClick={stopSession}
                  style={{ padding: '12px 24px', background: '#ef4444', color: 'white',
                           border: 'none', borderRadius: 8, fontSize: 16, cursor: 'pointer' }}>
            結束會議
          </button>
        )}
      </div>

      {/* AI 建議 */}
      <div style={{ padding: 16, border: '1px solid #ddd', borderRadius: 8, minHeight: 200 }}>
        <h3>AI 建議回覆</h3>
        {suggestions.length === 0 ? (
          <p style={{ color: '#999' }}>等待對話中...</p>
        ) : (
          suggestions.map((s, i) => (
            <div key={i} style={{ padding: 8, marginBottom: 8, background: '#f0f9ff',
                                   borderRadius: 4, borderLeft: '3px solid #3b82f6' }}>
              {s.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default App;
