import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type Status = 'idle' | 'connecting' | 'active' | 'ended';

interface Suggestion {
  type: 'text' | 'audio' | 'video';
  text?: string;
  audioUrl?: string;
  videoUrl?: string;
  timestamp: number;
}

function App() {
  const [apiUrl, setApiUrl] = useState('https://ai-avatar-saas-production.up.railway.app');
  const [token, setToken] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [mode, setMode] = useState(1);
  const [status, setStatus] = useState<Status>('idle');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [inputText, setInputText] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 計時器
  useEffect(() => {
    if (status === 'active') {
      const start = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - start) / 1000));
      }, 1000);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status]);

  // 監聽 WebSocket 事件
  useEffect(() => {
    const unlisten1 = listen<string>('ws-message', (event) => {
      try {
        const msg = JSON.parse(event.payload);
        if (msg.type === 'suggestion_text') {
          setSuggestions(prev => [...prev, {
            type: 'text',
            text: msg.payload?.text || msg.data?.text || '',
            timestamp: Date.now(),
          }]);
        } else if (msg.type === 'tts_audio') {
          const audioUrl = msg.data?.audio_url || '';
          setSuggestions(prev => [...prev, {
            type: 'audio',
            audioUrl,
            timestamp: Date.now(),
          }]);
          // 自動播放音訊
          if (audioUrl && audioRef.current) {
            audioRef.current.src = audioUrl;
            audioRef.current.play().catch(() => {});
          }
        } else if (msg.type === 'avatar_video') {
          setSuggestions(prev => [...prev, {
            type: 'video',
            videoUrl: msg.data?.video_url || '',
            timestamp: Date.now(),
          }]);
        }
      } catch (e) {
        console.error('解析訊息失敗', e);
      }
    });

    const unlisten2 = listen<string>('ws-disconnected', () => {
      setStatus('ended');
    });

    return () => {
      unlisten1.then(fn => fn());
      unlisten2.then(fn => fn());
    };
  }, []);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const handleConnect = async () => {
    if (!token || !sessionId) {
      alert('請填入 Token 和 Session ID');
      return;
    }
    setStatus('connecting');
    try {
      await invoke('connect_session', { apiUrl, token, sessionId, mode });
      setStatus('active');
      setSuggestions([]);
      setElapsed(0);
    } catch (e) {
      alert('連線失敗: ' + e);
      setStatus('idle');
    }
  };

  const handleDisconnect = async () => {
    try {
      await invoke('disconnect_session');
    } catch (e) {
      console.error(e);
    }
    setStatus('ended');
  };

  const handleSend = async () => {
    if (!inputText.trim()) return;
    try {
      await invoke('send_text', { text: inputText, mode });
      setInputText('');
    } catch (e) {
      alert('傳送失敗: ' + e);
    }
  };

  const handleReset = () => {
    setStatus('idle');
    setSuggestions([]);
    setElapsed(0);
    setSessionId('');
  };

  return (
    <div style={{ padding: 20, fontFamily: 'system-ui', maxWidth: 800, margin: '0 auto', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* 隱藏的音訊播放器 */}
      <audio ref={audioRef} style={{ display: 'none' }} />

      {/* 標題列 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>AI Avatar Desktop</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {status === 'active' && (
            <span style={{ fontFamily: 'monospace', fontSize: 18, fontWeight: 'bold', background: '#f3f4f6', padding: '4px 12px', borderRadius: 8 }}>
              {formatTime(elapsed)}
            </span>
          )}
          <span style={{
            padding: '4px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600,
            background: status === 'idle' ? '#f3f4f6' : status === 'connecting' ? '#fef3c7' : status === 'active' ? '#d1fae5' : '#f3f4f6',
            color: status === 'idle' ? '#6b7280' : status === 'connecting' ? '#92400e' : status === 'active' ? '#065f46' : '#6b7280',
          }}>
            {status === 'idle' ? '待機中' : status === 'connecting' ? '連線中...' : status === 'active' ? '會議中' : '已結束'}
          </span>
        </div>
      </div>

      {/* 待機畫面 */}
      {status === 'idle' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* 說明 */}
          <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: 12 }}>
            <p style={{ margin: 0, fontSize: 13, color: '#1e40af', fontWeight: 600, marginBottom: 4 }}>使用方式：</p>
            <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: '#1e40af' }}>
              <li>打開 Zoom / Google Meet / Teams 加入會議</li>
              <li>先在 Web 版啟動一個 Session，取得 Session ID 和 Token</li>
              <li>將 Token 和 Session ID 填入下方，選擇模式</li>
              <li>點擊「連線」，將對方說的話輸入文字框</li>
              <li>AI 即時給你回答建議</li>
            </ol>
          </div>

          {/* 連線設定 */}
          <div style={{ padding: 16, border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>連線設定</h3>
            <div style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 13, fontWeight: 500 }}>API URL:</label>
              <input value={apiUrl} onChange={e => setApiUrl(e.target.value)}
                style={{ width: '100%', padding: 8, marginTop: 4, borderRadius: 6, border: '1px solid #d1d5db', boxSizing: 'border-box' }} />
            </div>
            <div style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 13, fontWeight: 500 }}>Token:</label>
              <input value={token} onChange={e => setToken(e.target.value)}
                type="password" placeholder="JWT token from web login"
                style={{ width: '100%', padding: 8, marginTop: 4, borderRadius: 6, border: '1px solid #d1d5db', boxSizing: 'border-box' }} />
            </div>
            <div style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 13, fontWeight: 500 }}>Session ID:</label>
              <input value={sessionId} onChange={e => setSessionId(e.target.value)}
                placeholder="From web session/start"
                style={{ width: '100%', padding: 8, marginTop: 4, borderRadius: 6, border: '1px solid #d1d5db', boxSizing: 'border-box' }} />
            </div>
          </div>

          {/* 模式選擇 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            {[
              { id: 1, name: 'Mode 1', desc: 'Prompt 提詞', detail: 'AI 顯示建議文字', color: '#3b82f6' },
              { id: 2, name: 'Mode 2', desc: '語音分身', detail: 'AI 用你的聲音回答', color: '#8b5cf6' },
              { id: 3, name: 'Mode 3', desc: '完整分身', detail: 'AI 臉+聲音替你開會', color: '#f97316' },
            ].map(m => (
              <button key={m.id} onClick={() => setMode(m.id)}
                style={{
                  padding: 12, borderRadius: 10, border: `2px solid ${mode === m.id ? m.color : '#e5e7eb'}`,
                  background: mode === m.id ? `${m.color}10` : 'white', cursor: 'pointer', textAlign: 'left',
                }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>{m.name}</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>{m.desc}</div>
                <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{m.detail}</div>
              </button>
            ))}
          </div>

          {mode >= 2 && (
            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 8, fontSize: 12, color: '#92400e' }}>
              Mode {mode} 需要 GPU 服務運行中。語音會在桌面 App 播放。
            </div>
          )}

          <button onClick={handleConnect}
            style={{ padding: '12px 24px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: 10, fontSize: 16, cursor: 'pointer', fontWeight: 600 }}>
            連線會議
          </button>
        </div>
      )}

      {/* 連線中 */}
      {status === 'connecting' && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: '#6b7280', fontSize: 16 }}>正在建立連線...</p>
        </div>
      )}

      {/* 活躍會議 */}
      {status === 'active' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
          {/* AI 建議區 */}
          <div style={{ flex: 1, overflow: 'auto', padding: 16, border: '1px solid #e5e7eb', borderRadius: 8, background: '#fafafa' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>AI 建議回覆</h3>
            {suggestions.length === 0 ? (
              <p style={{ color: '#9ca3af' }}>等待對話中... 在下方輸入對方說的話</p>
            ) : (
              suggestions.map((s, i) => (
                <div key={i} style={{
                  padding: 10, marginBottom: 8, borderRadius: 6,
                  borderLeft: `3px solid ${s.type === 'text' ? '#3b82f6' : s.type === 'audio' ? '#8b5cf6' : '#f97316'}`,
                  background: s.type === 'text' ? '#eff6ff' : s.type === 'audio' ? '#f5f3ff' : '#fff7ed',
                }}>
                  {s.type === 'text' && <p style={{ margin: 0, fontSize: 14 }}>{s.text}</p>}
                  {s.type === 'audio' && (
                    <div>
                      <p style={{ margin: '0 0 6px', fontSize: 12, color: '#7c3aed' }}>TTS 語音已播放</p>
                      <audio controls src={s.audioUrl} style={{ width: '100%', height: 32 }} />
                    </div>
                  )}
                  {s.type === 'video' && (
                    <div>
                      <p style={{ margin: '0 0 6px', fontSize: 12, color: '#ea580c' }}>Avatar 影片</p>
                      <video controls src={s.videoUrl} style={{ width: '100%', maxHeight: 200, borderRadius: 4 }} />
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {/* 文字輸入 */}
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSend()}
              placeholder="輸入對方說的話..."
              style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14 }}
            />
            <button onClick={handleSend}
              style={{ padding: '10px 20px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
              傳送
            </button>
          </div>

          {/* 控制列 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>
              Session: <span style={{ fontFamily: 'monospace' }}>{sessionId.slice(0, 8)}...</span> | Mode {mode}
            </span>
            <button onClick={handleDisconnect}
              style={{ padding: '6px 16px', background: '#ef4444', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              結束會議
            </button>
          </div>
        </div>
      )}

      {/* 已結束 */}
      {status === 'ended' && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ width: 64, height: 64, borderRadius: 32, background: '#d1fae5', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 28 }}>
              ✓
            </div>
            <h3 style={{ marginBottom: 8 }}>會議已結束</h3>
            <p style={{ color: '#6b7280', marginBottom: 4 }}>總時長：{formatTime(elapsed)}</p>
            <p style={{ color: '#6b7280', marginBottom: 20 }}>AI 共提供 {suggestions.length} 則建議</p>
            <button onClick={handleReset}
              style={{ padding: '10px 24px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
              新的會議
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
