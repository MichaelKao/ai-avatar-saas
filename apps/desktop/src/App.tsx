import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type Status = 'idle' | 'connecting' | 'active';

interface LogEntry {
  type: 'stt' | 'ai-text' | 'ai-audio' | 'ai-video' | 'system';
  text: string;
  timestamp: number;
}

function App() {
  // 設定（儲存在 localStorage）
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem('apiUrl') || 'https://ai-avatar-saas-production.up.railway.app');
  const [gpuUrl, setGpuUrl] = useState(() => localStorage.getItem('gpuUrl') || 'https://oq00jb5vt1laws-8888.proxy.runpod.net');
  const [token, setToken] = useState(() => localStorage.getItem('token') || '');
  const [mode, setMode] = useState(() => parseInt(localStorage.getItem('mode') || '3'));
  const [showSettings, setShowSettings] = useState(false);

  const [status, setStatus] = useState<Status>('idle');
  const [sessionId, setSessionId] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  // 儲存設定到 localStorage
  useEffect(() => {
    localStorage.setItem('apiUrl', apiUrl);
    localStorage.setItem('gpuUrl', gpuUrl);
    localStorage.setItem('token', token);
    localStorage.setItem('mode', mode.toString());
  }, [apiUrl, gpuUrl, token, mode]);

  // 自動滾動 log
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

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

  // 監聽事件
  useEffect(() => {
    const unlisten1 = listen<string>('ws-message', (event) => {
      try {
        const msg = JSON.parse(event.payload);
        if (msg.type === 'suggestion_text') {
          const text = msg.payload?.text || msg.data?.text || '';
          addLog('ai-text', text);
        } else if (msg.type === 'tts_audio') {
          const audioUrl = msg.data?.audio_url || '';
          addLog('ai-audio', '語音回覆已產生');
          if (audioUrl && audioRef.current) {
            audioRef.current.src = audioUrl;
            audioRef.current.play().catch(() => {});
          }
        } else if (msg.type === 'avatar_video') {
          addLog('ai-video', msg.data?.video_url || '');
        } else if (msg.type === 'tts_status') {
          addLog('system', 'AI 正在產生語音...');
        }
      } catch (e) {
        console.error('解析訊息失敗', e);
      }
    });

    const unlisten2 = listen<string>('ws-disconnected', () => {
      addLog('system', '連線已斷開');
      setStatus('idle');
    });

    const unlisten3 = listen<string>('stt-result', (event) => {
      addLog('stt', `對方說：${event.payload}`);
    });

    return () => {
      unlisten1.then(fn => fn());
      unlisten2.then(fn => fn());
      unlisten3.then(fn => fn());
    };
  }, []);

  const addLog = (type: LogEntry['type'], text: string) => {
    setLogs(prev => [...prev.slice(-100), { type, text, timestamp: Date.now() }]);
  };

  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const formatLogTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
  };

  // === 一鍵啟動 ===
  const handleStart = async () => {
    if (!token) {
      setShowSettings(true);
      return;
    }

    setStatus('connecting');
    setLogs([]);
    setElapsed(0);
    addLog('system', '正在建立連線...');

    try {
      // Step 1: 建立 Session
      addLog('system', '建立 AI 會議 Session...');
      const resp = await fetch(`${apiUrl}/api/v1/session/start`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '建立 Session 失敗');

      const sid = data.data?.sessionId || data.data?.id;
      if (!sid) throw new Error('無法取得 Session ID');
      setSessionId(sid);
      addLog('system', `Session 已建立: ${sid.slice(0, 8)}...`);

      // Step 2: 連接 WebSocket
      addLog('system', '連接 WebSocket...');
      await invoke('connect_session', { apiUrl, token, sessionId: sid, mode });
      addLog('system', 'WebSocket 已連線');

      // Step 3: 啟動自動模式（音訊擷取 + STT）
      addLog('system', '啟動音訊擷取 + 語音辨識...');
      await invoke('start_auto_mode', { app: null, gpuUrl, mode });
      addLog('system', '自動模式已啟動 — AI 分身就緒！');

      setStatus('active');
    } catch (e: any) {
      addLog('system', `啟動失敗: ${e.message || e}`);
      setStatus('idle');
    }
  };

  // === 一鍵停止 ===
  const handleStop = async () => {
    try {
      await invoke('stop_auto_mode');
      await invoke('disconnect_session');

      // 結束 Session
      if (sessionId) {
        await fetch(`${apiUrl}/api/v1/session/${sessionId}/end`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` },
        }).catch(() => {});
      }
    } catch (e) {
      console.error(e);
    }
    addLog('system', '分身已停止');
    setStatus('idle');
  };

  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      background: status === 'active' ? '#0f172a' : '#f8fafc',
      color: status === 'active' ? '#e2e8f0' : '#1e293b',
      transition: 'all 0.3s',
    }}>
      {/* 隱藏音訊播放器 */}
      <audio ref={audioRef} style={{ display: 'none' }} />

      {/* 頂部列 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 20px',
        borderBottom: `1px solid ${status === 'active' ? '#334155' : '#e2e8f0'}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 20, fontWeight: 700 }}>AI 分身</span>
          <span style={{
            fontSize: 11, padding: '3px 10px', borderRadius: 99, fontWeight: 600,
            background: status === 'idle' ? '#f1f5f9' : status === 'connecting' ? '#fef3c7' : '#065f46',
            color: status === 'idle' ? '#64748b' : status === 'connecting' ? '#92400e' : '#a7f3d0',
          }}>
            {status === 'idle' ? '待機' : status === 'connecting' ? '啟動中' : '運行中'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {status === 'active' && (
            <span style={{ fontFamily: 'monospace', fontSize: 16, fontWeight: 700, color: '#a7f3d0' }}>
              {formatTime(elapsed)}
            </span>
          )}
          <button onClick={() => setShowSettings(!showSettings)} style={{
            background: 'none', border: 'none', cursor: 'pointer', fontSize: 20,
            color: status === 'active' ? '#94a3b8' : '#64748b',
          }}>
            ⚙
          </button>
        </div>
      </div>

      {/* 設定面板 */}
      {showSettings && (
        <div style={{
          padding: 16, borderBottom: `1px solid ${status === 'active' ? '#334155' : '#e2e8f0'}`,
          background: status === 'active' ? '#1e293b' : '#fff',
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, opacity: 0.7 }}>API URL</label>
              <input value={apiUrl} onChange={e => setApiUrl(e.target.value)}
                style={{ width: '100%', padding: 6, borderRadius: 4, border: '1px solid #cbd5e1', fontSize: 12, boxSizing: 'border-box', background: status === 'active' ? '#0f172a' : '#fff', color: status === 'active' ? '#e2e8f0' : '#000' }} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, opacity: 0.7 }}>GPU URL</label>
              <input value={gpuUrl} onChange={e => setGpuUrl(e.target.value)}
                style={{ width: '100%', padding: 6, borderRadius: 4, border: '1px solid #cbd5e1', fontSize: 12, boxSizing: 'border-box', background: status === 'active' ? '#0f172a' : '#fff', color: status === 'active' ? '#e2e8f0' : '#000' }} />
            </div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 11, fontWeight: 600, opacity: 0.7 }}>JWT Token</label>
            <input value={token} onChange={e => setToken(e.target.value)} type="password"
              placeholder="登入 Web 版後，從 DevTools → Local Storage 複製 token"
              style={{ width: '100%', padding: 6, borderRadius: 4, border: '1px solid #cbd5e1', fontSize: 12, boxSizing: 'border-box', background: status === 'active' ? '#0f172a' : '#fff', color: status === 'active' ? '#e2e8f0' : '#000' }} />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[
              { id: 1, name: 'Mode 1 提詞', color: '#3b82f6' },
              { id: 2, name: 'Mode 2 語音', color: '#8b5cf6' },
              { id: 3, name: 'Mode 3 完整', color: '#f97316' },
            ].map(m => (
              <button key={m.id} onClick={() => setMode(m.id)} style={{
                flex: 1, padding: '6px 0', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                border: `2px solid ${mode === m.id ? m.color : '#cbd5e1'}`,
                background: mode === m.id ? m.color : 'transparent',
                color: mode === m.id ? '#fff' : (status === 'active' ? '#94a3b8' : '#64748b'),
              }}>
                {m.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 主畫面 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* 待機畫面 */}
        {status === 'idle' && !showSettings && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ textAlign: 'center', maxWidth: 400 }}>
              <div style={{
                width: 100, height: 100, borderRadius: 50, margin: '0 auto 20px',
                background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 48, color: '#fff',
              }}>
                🤖
              </div>
              <h2 style={{ margin: '0 0 8px', fontSize: 24 }}>AI 數位分身</h2>
              <p style={{ margin: '0 0 24px', color: '#64748b', fontSize: 14, lineHeight: 1.6 }}>
                一鍵啟動 AI 分身。接起 Zoom、Google Meet、Teams、LINE 任何視訊或通話，AI 會自動聽對方說話、用你的聲音和臉回應。
              </p>

              <div style={{
                background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8,
                padding: 12, marginBottom: 20, textAlign: 'left',
              }}>
                <p style={{ margin: '0 0 6px', fontSize: 12, fontWeight: 700, color: '#0369a1' }}>首次使用請先設定：</p>
                <ol style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: '#0369a1', lineHeight: 1.8 }}>
                  <li>安裝 <b>VB-Cable</b>（虛擬麥克風）</li>
                  <li>安裝 <b>OBS Virtual Camera</b>（虛擬攝影機）</li>
                  <li>視訊軟體設定麥克風為「VB-Cable Output」</li>
                  <li>視訊軟體設定攝影機為「OBS Virtual Camera」</li>
                  <li>點右上 ⚙ 填入 Token</li>
                </ol>
              </div>

              <button onClick={handleStart} style={{
                width: '100%', padding: '14px 0', borderRadius: 12, border: 'none',
                background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                color: '#fff', fontSize: 18, fontWeight: 700, cursor: 'pointer',
                boxShadow: '0 4px 15px rgba(59,130,246,0.4)',
              }}>
                啟動分身
              </button>
            </div>
          </div>
        )}

        {/* 連線中 */}
        {status === 'connecting' && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                width: 60, height: 60, border: '3px solid #3b82f6', borderTopColor: 'transparent',
                borderRadius: 30, margin: '0 auto 16px',
                animation: 'spin 1s linear infinite',
              }} />
              <p style={{ color: '#64748b', fontSize: 16 }}>啟動 AI 分身中...</p>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          </div>
        )}

        {/* 運行中 — Log 畫面 */}
        {status === 'active' && (
          <>
            <div style={{
              flex: 1, overflow: 'auto', padding: '12px 16px',
              fontSize: 13, lineHeight: 1.6,
            }}>
              {logs.map((log, i) => (
                <div key={i} style={{
                  display: 'flex', gap: 8, marginBottom: 4,
                  opacity: log.type === 'system' ? 0.5 : 1,
                }}>
                  <span style={{ color: '#64748b', fontSize: 11, fontFamily: 'monospace', flexShrink: 0, marginTop: 2 }}>
                    {formatLogTime(log.timestamp)}
                  </span>
                  <span style={{
                    fontSize: 11, fontWeight: 700, flexShrink: 0, marginTop: 2,
                    color: log.type === 'stt' ? '#38bdf8'
                      : log.type === 'ai-text' ? '#4ade80'
                      : log.type === 'ai-audio' ? '#c084fc'
                      : log.type === 'ai-video' ? '#fb923c'
                      : '#64748b',
                  }}>
                    {log.type === 'stt' ? '[聽到]'
                      : log.type === 'ai-text' ? '[AI]'
                      : log.type === 'ai-audio' ? '[語音]'
                      : log.type === 'ai-video' ? '[影片]'
                      : '[系統]'}
                  </span>
                  <span>{log.text}</span>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>

            {/* 底部控制列 */}
            <div style={{
              padding: '10px 16px', borderTop: '1px solid #334155',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div style={{ fontSize: 12, color: '#64748b' }}>
                Mode {mode} | Session: {sessionId.slice(0, 8)}...
              </div>
              <button onClick={handleStop} style={{
                padding: '8px 24px', borderRadius: 8, border: 'none',
                background: '#ef4444', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
              }}>
                停止分身
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
