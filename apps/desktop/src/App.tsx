import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type AppScreen = 'login' | 'setup' | 'main';
type Status = 'idle' | 'connecting' | 'active';
type ObsStatus = 'off' | 'starting' | 'running';
type SttMode = 'local' | 'remote';

interface LogEntry {
  type: 'stt' | 'ai-text' | 'ai-audio' | 'ai-video' | 'system' | 'debug';
  text: string;
  timestamp: number;
}

interface Scene {
  id: string;
  name: string;
  scene_type: string;
  language: string;
  is_default: boolean;
}

// ---------------------------------------------------------------------------
// Shared style helpers
// ---------------------------------------------------------------------------
const inputStyle = (dark: boolean): React.CSSProperties => ({
  width: '100%',
  padding: '10px 12px',
  borderRadius: 8,
  border: `1px solid ${dark ? '#334155' : '#cbd5e1'}`,
  fontSize: 14,
  boxSizing: 'border-box',
  background: dark ? '#0f172a' : '#fff',
  color: dark ? '#e2e8f0' : '#1e293b',
  outline: 'none',
  transition: 'border-color 0.2s',
});

const gradientBg = 'linear-gradient(135deg, #3b82f6, #8b5cf6)';

// ---------------------------------------------------------------------------
// SVG Icons
// ---------------------------------------------------------------------------
const IconGear = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="10" cy="10" r="3" />
    <path d="M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M3.4 3.4l1.4 1.4M15.2 15.2l1.4 1.4M3.4 16.6l1.4-1.4M15.2 4.8l1.4-1.4" />
  </svg>
);

const IconUser = () => (
  <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="24" cy="18" r="8" />
    <path d="M8 42c0-8.8 7.2-16 16-16s16 7.2 16 16" />
  </svg>
);

const IconLogout = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 14H3a1 1 0 01-1-1V3a1 1 0 011-1h3M11 11l3-3-3-3M14 8H6" />
  </svg>
);

const IconCamera = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 4.5a1 1 0 011-1h2.5l1-1.5h5l1 1.5H14a1 1 0 011 1v7a1 1 0 01-1 1H2a1 1 0 01-1-1v-7z" />
    <circle cx="8" cy="8" r="2.5" />
  </svg>
);

// ---------------------------------------------------------------------------
// AvatarWindow — 獨立無邊框視窗，只顯示 Avatar 影片（給 OBS 擷取用）
// ---------------------------------------------------------------------------
function AvatarWindow() {
  const avatarRef = useRef<HTMLVideoElement | null>(null);
  const [showAvatar, setShowAvatar] = useState(false);
  const [faceSnapshot, setFaceSnapshot] = useState('');

  // 接收臉部截圖（webcam 不可用時的備用畫面）
  useEffect(() => {
    const unlisten = listen<string>('avatar-face-snapshot', (event) => {
      if (event.payload) setFaceSnapshot(event.payload);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // 接收 Wav2Lip 影片（AI 回應時播放）
  useEffect(() => {
    const unlisten = listen<string>('avatar-video-update', (event) => {
      if (event.payload && avatarRef.current) {
        avatarRef.current.src = event.payload;
        avatarRef.current.play().then(() => {
          setShowAvatar(true);
        }).catch(() => {});
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // 影片播放結束 → 回到 webcam 畫面
  const handleAvatarEnded = () => {
    setShowAvatar(false);
  };

  const containerStyle: React.CSSProperties = {
    width: '100vw',
    height: '100vh',
    background: '#000',
    position: 'relative',
    overflow: 'hidden',
    cursor: 'default',
  };

  const fullCover: React.CSSProperties = {
    position: 'absolute',
    top: 0, left: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  };

  return (
    <div style={containerStyle}>
      {/* 底層：啟動時擷取的臉部截圖（穩定可靠，不受攝影機停用影響） */}
      {faceSnapshot && (
        <img
          src={`data:image/jpeg;base64,${faceSnapshot}`}
          style={{ ...fullCover, transform: 'scaleX(-1)' }}
          alt=""
        />
      )}
      {/* 頂層：Wav2Lip AI 影片（AI 回應時蓋住 webcam） */}
      <video
        ref={avatarRef}
        style={{ ...fullCover, display: showAvatar ? 'block' : 'none', zIndex: 10 }}
        playsInline
        onEnded={handleAvatarEnded}
        onError={handleAvatarEnded}
      />
      {/* 無任何畫面時顯示提示 */}
      {!faceSnapshot && (
        <div style={{
          ...fullCover, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#475569', fontSize: 14, textAlign: 'center',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}>
          <div>啟動中...</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OverlayWindow — 半透明懸浮提示視窗（Mode 1 用）
// ---------------------------------------------------------------------------
function OverlayWindow() {
  const [text, setText] = useState('');
  const [visible, setVisible] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unlisten = listen<string>('overlay-text-update', (event) => {
      if (event.payload) {
        setText(event.payload);
        setVisible(true);
        // 自動隱藏計時器（15 秒後淡出）
        if (fadeTimer.current) clearTimeout(fadeTimer.current);
        fadeTimer.current = setTimeout(() => setVisible(false), 15000);
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // 拖曳功能
  const handleMouseDown = async () => {
    setIsDragging(true);
    try {
      await getCurrentWindow().startDragging();
    } catch (_) {}
    setIsDragging(false);
  };

  return (
    <div
      onMouseDown={handleMouseDown}
      style={{
        width: '100vw',
        height: '100vh',
        background: 'transparent',
        cursor: isDragging ? 'grabbing' : 'grab',
        userSelect: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 12,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <div style={{
        width: '100%',
        maxHeight: '100%',
        background: 'rgba(15, 23, 42, 0.88)',
        borderRadius: 14,
        padding: '16px 20px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        border: '1px solid rgba(99, 102, 241, 0.3)',
        opacity: visible ? 1 : 0.3,
        transition: 'opacity 0.5s ease',
        overflow: 'auto',
      }}>
        {/* 頂部指示條 */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: text ? 10 : 0,
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: 4,
            background: visible ? '#4ade80' : '#475569',
            transition: 'background 0.3s',
          }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8' }}>
            AI 建議回答
          </span>
          <span style={{
            marginLeft: 'auto', fontSize: 10, color: '#475569',
          }}>
            拖曳移動
          </span>
        </div>

        {/* AI 建議文字 */}
        {text ? (
          <div style={{
            fontSize: 18,
            fontWeight: 500,
            color: '#f1f5f9',
            lineHeight: 1.6,
            letterSpacing: 0.3,
          }}>
            {text}
          </div>
        ) : (
          <div style={{
            fontSize: 14,
            color: '#64748b',
            textAlign: 'center',
            padding: '8px 0',
          }}>
            等待 AI 回覆...
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LoginPage
// ---------------------------------------------------------------------------
function LoginPage({ apiUrl, onLogin }: { apiUrl: string; onLogin: (token: string) => void }) {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email || !password) {
      setError('請輸入電子郵件和密碼');
      return;
    }
    if (isRegister && password.length < 8) {
      setError('密碼至少 8 個字元');
      return;
    }
    setLoading(true);
    try {
      let body: any;
      if (isRegister) {
        body = await invoke('api_register', { apiUrl, email, password, name: name || email.split('@')[0] });
      } else {
        body = await invoke('api_login', { apiUrl, email, password });
      }
      const token = body.data?.token;
      if (!token) throw new Error('伺服器回傳格式異常，未取得 token');
      onLogin(token);
    } catch (err: any) {
      setError(typeof err === 'string' ? err : (err.message || (isRegister ? '註冊失敗' : '登入失敗')));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0f172a',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{
        width: 380,
        padding: '40px 36px',
        borderRadius: 16,
        background: '#1e293b',
        boxShadow: '0 25px 60px rgba(0,0,0,0.5)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 72, height: 72, borderRadius: 36, margin: '0 auto 16px',
            background: gradientBg,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <IconUser />
          </div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#f1f5f9' }}>AI 數位分身</h1>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: '#64748b' }}>
            {isRegister ? '建立新帳號' : '登入您的帳號以繼續'}
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          {isRegister && (
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>
                名稱（選填）
              </label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="您的名稱"
                style={inputStyle(true)}
              />
            </div>
          )}

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>
              電子郵件
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoFocus
              style={inputStyle(true)}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>
              密碼{isRegister ? '（至少 8 字元）' : ''}
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              style={inputStyle(true)}
            />
          </div>

          {error && (
            <div style={{
              marginBottom: 16, padding: '10px 14px', borderRadius: 8,
              background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
              color: '#fca5a5', fontSize: 13,
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '12px 0',
              borderRadius: 10,
              border: 'none',
              background: loading ? '#475569' : gradientBg,
              color: '#fff',
              fontSize: 16,
              fontWeight: 700,
              cursor: loading ? 'not-allowed' : 'pointer',
              boxShadow: loading ? 'none' : '0 4px 15px rgba(59,130,246,0.4)',
              transition: 'all 0.2s',
            }}
          >
            {loading ? (isRegister ? '註冊中...' : '登入中...') : (isRegister ? '註冊' : '登入')}
          </button>
        </form>

        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <button
            onClick={() => { setIsRegister(!isRegister); setError(''); }}
            style={{
              background: 'none', border: 'none', color: '#60a5fa',
              fontSize: 13, cursor: 'pointer', textDecoration: 'underline',
            }}
          >
            {isRegister ? '已有帳號？登入' : '沒有帳號？立即註冊'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SetupPage
// ---------------------------------------------------------------------------
function SetupPage({ onDone }: { onDone: () => void }) {
  const [progressMsg, setProgressMsg] = useState('正在檢測環境...');
  const [error, setError] = useState('');
  const [showSkip, setShowSkip] = useState(false);

  useEffect(() => {
    const unlisten = listen<string>('install-progress', (event) => {
      setProgressMsg(event.payload);
    });

    // 3 秒後顯示跳過按鈕，避免卡住
    const skipTimer = setTimeout(() => setShowSkip(true), 3000);

    const run = async () => {
      try {
        const result: any = await invoke('auto_setup');
        if (result.vb_cable) {
          setProgressMsg('環境就緒！');
          setTimeout(() => onDone(), 500);
        } else {
          setError(result.message || 'VB-Cable 未安裝（模式 1 提詞模式仍可使用）');
          setShowSkip(true);
        }
      } catch (e: any) {
        setError(typeof e === 'string' ? e : (e.message || '環境設定失敗'));
        setShowSkip(true);
      }
    };
    run();

    return () => {
      unlisten.then(fn => fn());
      clearTimeout(skipTimer);
    };
  }, [onDone]);

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0f172a',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      color: '#e2e8f0',
    }}>
      <div style={{ textAlign: 'center', maxWidth: 400, padding: '0 20px' }}>
        {!error ? (
          <>
            <div style={{
              width: 60, height: 60,
              border: '3px solid #3b82f6', borderTopColor: 'transparent',
              borderRadius: 30, margin: '0 auto 20px',
              animation: 'spin 1s linear infinite',
            }} />
            <h2 style={{ margin: '0 0 12px', fontSize: 20, fontWeight: 700 }}>首次啟動設定</h2>
            <p style={{ margin: 0, color: '#94a3b8', fontSize: 14 }}>{progressMsg}</p>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </>
        ) : (
          <>
            <div style={{
              width: 60, height: 60, borderRadius: 30, margin: '0 auto 20px',
              background: '#f59e0b', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 9v4M12 17h.01" />
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
            </div>
            <h2 style={{ margin: '0 0 12px', fontSize: 20, fontWeight: 700 }}>環境提示</h2>
            <p style={{ margin: '0 0 8px', color: '#fbbf24', fontSize: 14 }}>{error}</p>
            <p style={{ margin: '0 0 20px', color: '#94a3b8', fontSize: 12 }}>模式 2/3 需要 VB-Cable 虛擬音訊，模式 1 提詞模式可直接使用</p>
          </>
        )}
        {showSkip && (
          <button
            onClick={onDone}
            style={{
              marginTop: 16, padding: '10px 32px', borderRadius: 8,
              border: 'none', background: error ? gradientBg : '#475569',
              color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}
          >
            {error ? '繼續使用' : '跳過設定'}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------
function App() {
  // 判斷視窗類型
  const windowLabel = getCurrentWindow().label;
  if (windowLabel === 'avatar') {
    return <AvatarWindow />;
  }
  if (windowLabel === 'overlay') {
    return <OverlayWindow />;
  }

  return <MainApp />;
}

function MainApp() {
  // Auth state
  const [token, setToken] = useState(() => localStorage.getItem('token') || '');
  const [setupDone, setSetupDone] = useState(() => localStorage.getItem('setupDone') === 'true');

  // Settings — Gateway 和 GPU 都走 RunPod nginx 路由（同一個 URL）
  const defaultUrl = 'https://twjgc6ahrdxohs-8888.proxy.runpod.net';
  const [apiUrl, setApiUrl] = useState(() => {
    const stored = localStorage.getItem('apiUrl') || '';
    // 遷移舊 URL（Railway 或舊 RunPod pod）到新 RunPod
    if (stored.includes('railway.app') || stored.includes('yam5ie51sqxres')) {
      localStorage.setItem('apiUrl', defaultUrl);
      return defaultUrl;
    }
    return stored || defaultUrl;
  });
  const [gpuUrl, setGpuUrl] = useState(() => {
    const stored = localStorage.getItem('gpuUrl') || '';
    if (stored.includes('yam5ie51sqxres')) {
      localStorage.setItem('gpuUrl', defaultUrl);
      return defaultUrl;
    }
    return stored || defaultUrl;
  });
  const [mode, setMode] = useState(() => {
    const stored = localStorage.getItem('mode');
    // 舊版預設 Mode 3 需要 OBS，新版降級為 Mode 2 更穩定
    if (stored === '3' && !localStorage.getItem('v07_migrated')) {
      localStorage.setItem('mode', '2');
      localStorage.setItem('v07_migrated', 'true');
      return 2;
    }
    localStorage.setItem('v07_migrated', 'true');
    return parseInt(stored || '2');
  });
  const [voiceGender, setVoiceGender] = useState<'male' | 'female'>(() => (localStorage.getItem('voiceGender') as any) || 'female');
  const [sttMode, setSttMode] = useState<SttMode>(() => (localStorage.getItem('sttMode') as SttMode) || 'remote');
  const [showSettings, setShowSettings] = useState(false);

  // 場景
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [activeSceneId, setActiveSceneId] = useState(() => localStorage.getItem('activeSceneId') || '');

  // 本機 STT 狀態
  const [sttModelStatus, setSttModelStatus] = useState<{ ready: boolean; cli_downloaded: boolean; model_downloaded: boolean }>({ ready: false, cli_downloaded: false, model_downloaded: false });
  const [sttDownloadProgress, setSttDownloadProgress] = useState('');

  // Runtime state
  const [status, setStatus] = useState<Status>('idle');
  const [sessionId, setSessionId] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  // Avatar 影片 + OBS 虛擬鏡頭
  const [avatarVideoUrl, setAvatarVideoUrl] = useState('');
  const [obsStatus, setObsStatus] = useState<ObsStatus>('off');
  const avatarVideoRef = useRef<HTMLVideoElement | null>(null);

  // 手動文字輸入（除錯用）
  const [manualText, setManualText] = useState('');

  // 連線狀態指示燈
  const [healthStatus, setHealthStatus] = useState<{ gateway: boolean | null; gpu: boolean | null }>({ gateway: null, gpu: null });

  // 啟動失敗錯誤訊息
  const [startError, setStartError] = useState('');

  const screen: AppScreen = !token ? 'login' : !setupDone ? 'setup' : 'main';

  // -----------------------------------------------------------------------
  // Persist settings
  // -----------------------------------------------------------------------
  useEffect(() => {
    localStorage.setItem('apiUrl', apiUrl);
    localStorage.setItem('gpuUrl', gpuUrl);
    localStorage.setItem('mode', mode.toString());
    localStorage.setItem('voiceGender', voiceGender);
    localStorage.setItem('sttMode', sttMode);
    if (activeSceneId) localStorage.setItem('activeSceneId', activeSceneId);
  }, [apiUrl, gpuUrl, mode, voiceGender, sttMode, activeSceneId]);

  useEffect(() => {
    if (token) localStorage.setItem('token', token);
    else localStorage.removeItem('token');
  }, [token]);

  useEffect(() => {
    localStorage.setItem('setupDone', setupDone ? 'true' : 'false');
  }, [setupDone]);

  // -----------------------------------------------------------------------
  // 連線健康檢查（進入主畫面後定期檢查）
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (screen !== 'main') return;
    const checkHealth = async () => {
      try {
        const result: any = await invoke('api_check_health', { apiUrl, gpuUrl });
        setHealthStatus({ gateway: result.gateway, gpu: result.gpu });
      } catch {
        setHealthStatus({ gateway: false, gpu: false });
      }
    };
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, [screen, apiUrl, gpuUrl]);

  // -----------------------------------------------------------------------
  // Auto-scroll logs
  // -----------------------------------------------------------------------
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // -----------------------------------------------------------------------
  // Timer
  // -----------------------------------------------------------------------
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

  // -----------------------------------------------------------------------
  // Tauri event listeners
  // -----------------------------------------------------------------------
  useEffect(() => {
    const unlisten1 = listen<string>('ws-message', (event) => {
      try {
        const msg = JSON.parse(event.payload);
        if (msg.type === 'suggestion_text') {
          const text = msg.payload?.text || msg.data?.text || '';
          // 串流增量更新 — 替換最後一筆 AI 文字，避免重複顯示
          setLogs(prev => {
            const lastIdx = prev.length - 1;
            if (lastIdx >= 0 && prev[lastIdx].type === 'ai-text') {
              const updated = [...prev];
              updated[lastIdx] = { ...updated[lastIdx], text };
              return updated;
            }
            return [...prev, { type: 'ai-text', text, timestamp: Date.now() }];
          });
          // Mode 1: 同步更新懸浮提示視窗
          invoke('update_overlay_text', { text }).catch(() => {});
        } else if (msg.type === 'tts_audio') {
          // 舊模式（非串流回退）：整段音訊
          const audioUrl = msg.data?.audio_url || '';
          addLog('ai-audio', '語音回覆已產生');
          if (audioUrl) {
            invoke('play_audio_to_vbcable', { audioUrl }).then(() => {
              addLog('ai-audio', '語音已送出到虛擬麥克風');
            }).catch((err) => {
              addLog('system', `VB-Cable 播放失敗: ${err}，請確認已安裝 VB-Cable`);
            });
          }
        } else if (msg.type === 'tts_audio_chunk') {
          // 串流模式：逐句音訊（Rust 層自動下載 + 入隊播放，這裡只更新 UI）
          const idx = msg.data?.index ?? 0;
          if (idx === 0) {
            addLog('ai-audio', '串流語音開始...');
          }
        } else if (msg.type === 'tts_stream_end') {
          const total = msg.data?.total_chunks ?? 0;
          addLog('ai-audio', `語音串流完成 (${total} 段)`);
        } else if (msg.type === 'avatar_frame') {
          // MuseTalk 即時唇形動畫幀（base64 JPEG）
          const frame = msg.data?.frame || '';
          const frameIndex = msg.data?.index ?? 0;
          const totalFrames = msg.data?.total ?? 0;
          if (frame && frameIndex === 0) {
            addLog('ai-video', `MuseTalk 唇形動畫: ${totalFrames} 幀`);
          }
          if (frame) {
            setAvatarVideoUrl(`data:image/jpeg;base64,${frame}`);
            invoke('emit_avatar_frame', { frame }).catch(() => {});
          }
        } else if (msg.type === 'avatar_video') {
          const videoUrl = msg.data?.video_url || '';
          addLog('ai-video', `臉部動畫: ${videoUrl || '(空URL)'}`);
          if (videoUrl) {
            setAvatarVideoUrl(videoUrl);
            // 同步發送到 Avatar 獨立視窗
            invoke('emit_avatar_video', { videoUrl }).catch(() => {});
          }
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

    // 除錯事件（音訊擷取 + STT 狀態）
    const unlisten5 = listen<string>('debug-log', (event) => {
      addLog('debug', event.payload);
    });

    // OBS 安裝進度
    const unlisten4 = listen<string>('obs-install-progress', (event) => {
      addLog('system', event.payload);
    });

    // STT 模型下載進度
    const unlisten6 = listen<string>('stt-download-progress', (event) => {
      setSttDownloadProgress(event.payload);
    });

    return () => {
      unlisten1.then(fn => fn());
      unlisten2.then(fn => fn());
      unlisten3.then(fn => fn());
      unlisten4.then(fn => fn());
      unlisten5.then(fn => fn());
      unlisten6.then(fn => fn());
    };
  }, []);

  // 登入後載入場景列表 + 檢查本機 STT 模型
  useEffect(() => {
    if (!token) return;
    // 取得場景
    invoke('api_fetch_scenes', { apiUrl, token }).then((resp: any) => {
      const list = resp?.data || [];
      setScenes(list);
      // 自動選擇預設場景
      const defaultScene = list.find((s: Scene) => s.is_default);
      if (defaultScene && !activeSceneId) {
        setActiveSceneId(defaultScene.id);
      }
    }).catch(() => {});
    // 檢查 STT 模型
    invoke('get_stt_model_status').then((status: any) => {
      setSttModelStatus(status);
    }).catch(() => {});
  }, [token, apiUrl]);

  // -----------------------------------------------------------------------
  // 播放 Avatar 影片
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (avatarVideoUrl) {
      // 延遲 100ms 確保 video element 已渲染
      const timer = setTimeout(() => {
        if (avatarVideoRef.current) {
          avatarVideoRef.current.src = avatarVideoUrl;
          avatarVideoRef.current.play().catch(() => {});
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [avatarVideoUrl]);

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------
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

  // -----------------------------------------------------------------------
  // Auth actions
  // -----------------------------------------------------------------------
  const handleLogin = useCallback((newToken: string) => {
    setToken(newToken);
  }, []);

  const handleLogout = useCallback(async () => {
    if (status === 'active') {
      try {
        await invoke('stop_auto_mode');
        await invoke('disconnect_session');
      } catch (_) { /* ignore */ }
    }
    setToken('');
    setStatus('idle');
    setSessionId('');
    setLogs([]);
    setElapsed(0);
    setShowSettings(false);
    setObsStatus('off');
    setAvatarVideoUrl('');
    localStorage.removeItem('token');
  }, [status]);

  const handleSetupDone = useCallback(() => {
    setSetupDone(true);
  }, []);

  // -----------------------------------------------------------------------
  // Start / Stop
  // -----------------------------------------------------------------------
  // 擷取 webcam 單幀截圖（base64 JPEG）
  const captureWebcamFrame = async (): Promise<string> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
      });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.playsInline = true;
      await video.play();

      // 等一小段時間讓畫面穩定
      await new Promise(r => setTimeout(r, 500));

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(video, 0, 0);

      // 停止 webcam
      stream.getTracks().forEach(t => t.stop());

      // 轉成 base64（去掉 data:image/jpeg;base64, 前綴）
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      return dataUrl.split(',')[1] || '';
    } catch (e) {
      console.warn('Webcam 擷取失敗:', e);
      return '';
    }
  };

  // 直接啟動（不再顯示設定指南彈窗）
  const handleStartClick = () => {
    handleStart();
  };

  const handleStart = async () => {
    setShowSetupGuide(false);
    setStatus('connecting');
    setStartError('');
    setLogs([]);
    setElapsed(0);
    setAvatarVideoUrl('');

    // 輔助函數：記錄步驟並處理錯誤
    const step = (msg: string) => addLog('system', msg);
    const fail = (stepName: string, err: any) => {
      const msg = typeof err === 'string' ? err : (err?.message || String(err));
      return `[${stepName}] ${msg}`;
    };

    try {
      // ===== Step 1: 檢查伺服器連線 =====
      step('Step 1/6: 檢查伺服器連線...');
      try {
        const health: any = await invoke('api_check_health', { apiUrl, gpuUrl });
        setHealthStatus({ gateway: health.gateway, gpu: health.gpu });
        if (!health.gateway) {
          throw new Error(`Gateway 無法連線 (${apiUrl})`);
        }
        step('Gateway 連線正常');
        if (!health.gpu) {
          step('GPU 服務無法連線（語音辨識可能受影響）');
        } else {
          step('GPU 服務連線正常');
        }
      } catch (err: any) {
        throw new Error(fail('伺服器檢查', err));
      }

      // ===== Step 2: 建立 Session =====
      step('Step 2/6: 建立 AI 會議 Session...');
      let sid = '';
      try {
        const data: any = await invoke('api_start_session', { apiUrl, token });
        sid = data.data?.sessionId || data.data?.id;
        if (!sid) throw new Error('伺服器未回傳 Session ID');
        setSessionId(sid);
        step(`Session 已建立: ${sid.slice(0, 8)}...`);
      } catch (err: any) {
        if (err === 'TOKEN_EXPIRED' || String(err).includes('TOKEN_EXPIRED')) {
          setStartError('登入已過期，請重新登入');
          handleLogout();
          return;
        }
        throw new Error(fail('建立 Session', err));
      }

      // ===== Step 3: 連接 WebSocket =====
      step('Step 3/6: 連接 WebSocket...');
      try {
        await invoke('connect_session', { apiUrl, token, sessionId: sid, mode });
        step('WebSocket 連線成功');
      } catch (err: any) {
        throw new Error(fail('WebSocket 連線', err));
      }

      // ===== Step 4: 設定音訊/視訊裝置（非致命） =====
      step('Step 4/6: 設定裝置...');
      let faceBase64 = '';
      if (mode >= 2) {
        faceBase64 = await captureWebcamFrame();
        step(faceBase64 ? '臉部截圖完成' : '未偵測到攝影機（不影響使用）');
        try {
          await invoke('set_voice_and_face', { voiceGender, faceImageBase64: faceBase64 });
        } catch {}
      }
      if (mode >= 2) {
        try {
          await invoke('auto_set_default_mic');
          step('已切換麥克風到 VB-Cable');
        } catch {
          step('VB-Cable 未安裝（AI 語音將從喇叭播放）');
        }
      }
      if (mode === 3) {
        try {
          await invoke('ensure_obs_ready');
          await invoke('open_avatar_window');
          await new Promise(r => setTimeout(r, 1500));
          if (faceBase64) invoke('emit_avatar_face', { faceBase64 }).catch(() => {});
          const obsResult: string = await invoke('start_obs_virtual_cam', { password: null });
          setObsStatus('running');
          step(obsResult);
        } catch (obsErr: any) {
          step(`虛擬鏡頭失敗（${obsErr}），繼續語音模式`);
          invoke('close_avatar_window').catch(() => {});
          invoke('cleanup_obs').catch(() => {});
        }
      }

      // ===== Step 5: Mode 1 懸浮視窗 =====
      if (mode === 1) {
        step('Step 5/6: 開啟提示視窗...');
        try {
          await invoke('open_overlay_window');
          step('懸浮提示視窗已開啟');
        } catch (err: any) {
          step(`提示視窗: ${err}`);
        }
      } else {
        step('Step 5/6: 跳過（非提詞模式）');
      }

      // ===== Step 6: 啟動音訊擷取 =====
      step('Step 6/6: 啟動音訊擷取 + 語音辨識...');
      try {
        await invoke('start_auto_mode', { app: null, gpuUrl, mode, sttMode });
        step(`音訊擷取已啟動 (${sttMode === 'local' ? '本機 STT' : '雲端 STT'})`);
      } catch (audioErr: any) {
        step(`音訊擷取失敗: ${audioErr}`);
        step('可使用下方文字輸入框手動測試 AI');
      }

      setStatus('active');
      step('AI 分身已就緒！開始通話或用下方輸入框測試。');

    } catch (e: any) {
      const errorMsg = e.message || String(e);
      setStartError(errorMsg);
      addLog('system', `啟動失敗: ${errorMsg}`);
      // 清理
      invoke('close_avatar_window').catch(() => {});
      invoke('close_overlay_window').catch(() => {});
      invoke('cleanup_obs').catch(() => {});
      invoke('restore_default_mic').catch(() => {});
      invoke('restore_real_cameras').catch(() => {});
      invoke('disconnect_session').catch(() => {});
      invoke('stop_auto_mode').catch(() => {});
      setObsStatus('off');
      setStatus('idle');
    }
  };

  const handleStop = async () => {
    try {
      await invoke('stop_auto_mode');
      await invoke('disconnect_session');
      invoke('close_avatar_window').catch(() => {});
      invoke('close_overlay_window').catch(() => {});
      // 自動清理 OBS（停止虛擬鏡頭 + 關閉 OBS）
      invoke('cleanup_obs').catch(() => {});
      // 還原 Windows 預設麥克風和攝影機
      invoke('restore_default_mic').catch(() => {});
      invoke('restore_real_cameras').catch(() => {});

      if (sessionId) {
        await invoke('api_end_session', { apiUrl, token, sessionId }).catch(() => {});
      }
    } catch (e) {
      console.error(e);
    }
    addLog('system', '分身已停止');
    setStatus('idle');
    setObsStatus('off');
    setAvatarVideoUrl('');
  };

  // -----------------------------------------------------------------------
  // Render: Login
  // -----------------------------------------------------------------------
  if (screen === 'login') {
    return <LoginPage apiUrl={apiUrl} onLogin={handleLogin} />;
  }

  // -----------------------------------------------------------------------
  // Render: Setup
  // -----------------------------------------------------------------------
  if (screen === 'setup') {
    return <SetupPage onDone={handleSetupDone} />;
  }

  // -----------------------------------------------------------------------
  // Render: Main screen
  // -----------------------------------------------------------------------
  const dark = status === 'active';
  const isMode3 = mode === 3;

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      background: dark ? '#0f172a' : '#f8fafc',
      color: dark ? '#e2e8f0' : '#1e293b',
      transition: 'all 0.3s',
    }}>
      {/* Hidden audio player */}
      <audio ref={audioRef} style={{ display: 'none' }} />

      {/* Top bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 20px',
        borderBottom: `1px solid ${dark ? '#334155' : '#e2e8f0'}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 20, fontWeight: 700 }}>AI 分身</span>
          <span style={{
            fontSize: 11,
            padding: '3px 10px',
            borderRadius: 99,
            fontWeight: 600,
            background: status === 'idle' ? (dark ? '#334155' : '#f1f5f9')
              : status === 'connecting' ? '#fef3c7'
              : '#065f46',
            color: status === 'idle' ? '#64748b'
              : status === 'connecting' ? '#92400e'
              : '#a7f3d0',
          }}>
            {status === 'idle' ? '待機' : status === 'connecting' ? '啟動中' : '運行中'}
          </span>
          {obsStatus === 'running' && (
            <span style={{
              fontSize: 11,
              padding: '3px 10px',
              borderRadius: 99,
              fontWeight: 600,
              background: '#1e3a5f',
              color: '#60a5fa',
            }}>
              虛擬鏡頭
            </span>
          )}
          {/* 連線狀態指示燈 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 4 }}>
            <div title={`Gateway: ${healthStatus.gateway === null ? '檢查中' : healthStatus.gateway ? '正常' : '離線'}`}
              style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: dark ? '#94a3b8' : '#64748b' }}>
              <div style={{
                width: 8, height: 8, borderRadius: 4,
                background: healthStatus.gateway === null ? '#94a3b8' : healthStatus.gateway ? '#22c55e' : '#ef4444',
                boxShadow: healthStatus.gateway ? '0 0 4px #22c55e' : healthStatus.gateway === false ? '0 0 4px #ef4444' : 'none',
              }} />
              GW
            </div>
            <div title={`GPU: ${healthStatus.gpu === null ? '檢查中' : healthStatus.gpu ? '正常' : '離線'}`}
              style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: dark ? '#94a3b8' : '#64748b' }}>
              <div style={{
                width: 8, height: 8, borderRadius: 4,
                background: healthStatus.gpu === null ? '#94a3b8' : healthStatus.gpu ? '#22c55e' : '#ef4444',
                boxShadow: healthStatus.gpu ? '0 0 4px #22c55e' : healthStatus.gpu === false ? '0 0 4px #ef4444' : 'none',
              }} />
              GPU
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {status === 'active' && (
            <span style={{ fontFamily: 'monospace', fontSize: 16, fontWeight: 700, color: '#a7f3d0' }}>
              {formatTime(elapsed)}
            </span>
          )}
          <button
            onClick={() => setShowSettings(!showSettings)}
            title="設定"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: dark ? '#94a3b8' : '#64748b',
              display: 'flex',
              alignItems: 'center',
              padding: 4,
            }}
          >
            <IconGear />
          </button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div style={{
          padding: 16,
          borderBottom: `1px solid ${dark ? '#334155' : '#e2e8f0'}`,
          background: dark ? '#1e293b' : '#fff',
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, opacity: 0.7, marginBottom: 4 }}>API URL</label>
              <input
                value={apiUrl}
                onChange={e => setApiUrl(e.target.value)}
                style={inputStyle(dark)}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, opacity: 0.7, marginBottom: 4 }}>GPU URL</label>
              <input
                value={gpuUrl}
                onChange={e => setGpuUrl(e.target.value)}
                style={inputStyle(dark)}
              />
            </div>
          </div>

          {/* Mode selector */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {[
              { id: 1, name: 'Mode 1 提詞', color: '#3b82f6' },
              { id: 2, name: 'Mode 2 語音', color: '#8b5cf6' },
              { id: 3, name: 'Mode 3 完整', color: '#f97316' },
            ].map(m => (
              <button key={m.id} onClick={() => setMode(m.id)} style={{
                flex: 1,
                padding: '6px 0',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                border: `2px solid ${mode === m.id ? m.color : '#cbd5e1'}`,
                background: mode === m.id ? m.color : 'transparent',
                color: mode === m.id ? '#fff' : (dark ? '#94a3b8' : '#64748b'),
              }}>
                {m.name}
              </button>
            ))}
          </div>

          {/* 預設聲音性別（Mode 2/3 使用） */}
          {mode >= 2 && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, opacity: 0.7, marginBottom: 4 }}>
                預設聲音
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                {([
                  { id: 'female' as const, name: '女聲', emoji: '\u{1F469}' },
                  { id: 'male' as const, name: '男聲', emoji: '\u{1F468}' },
                ] as const).map(g => (
                  <button key={g.id} onClick={() => setVoiceGender(g.id)} style={{
                    flex: 1,
                    padding: '8px 0',
                    borderRadius: 6,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    border: `2px solid ${voiceGender === g.id ? '#8b5cf6' : (dark ? '#475569' : '#cbd5e1')}`,
                    background: voiceGender === g.id ? 'rgba(139,92,246,0.2)' : 'transparent',
                    color: voiceGender === g.id ? '#c4b5fd' : (dark ? '#94a3b8' : '#64748b'),
                  }}>
                    {g.emoji} {g.name}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>
                未上傳自訂聲音時使用，啟動時會自動擷取 webcam 臉部
              </div>
            </div>
          )}

          {/* 場景選擇 */}
          {scenes.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, opacity: 0.7, marginBottom: 4 }}>
                場景
              </label>
              <select
                value={activeSceneId}
                onChange={e => {
                  setActiveSceneId(e.target.value);
                  if (e.target.value) {
                    invoke('api_set_default_scene', { apiUrl, token, sceneId: e.target.value }).catch(() => {});
                  }
                }}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: `1px solid ${dark ? '#334155' : '#cbd5e1'}`,
                  background: dark ? '#0f172a' : '#fff',
                  color: dark ? '#e2e8f0' : '#1e293b',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                <option value="">未選擇（使用預設）</option>
                {scenes.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name} {s.is_default ? '(預設)' : ''} — {s.scene_type}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* STT 模式 */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, opacity: 0.7, marginBottom: 4 }}>
              語音辨識
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setSttMode('remote')} style={{
                flex: 1,
                padding: '6px 0',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                border: `2px solid ${sttMode === 'remote' ? '#3b82f6' : (dark ? '#475569' : '#cbd5e1')}`,
                background: sttMode === 'remote' ? 'rgba(59,130,246,0.2)' : 'transparent',
                color: sttMode === 'remote' ? '#60a5fa' : (dark ? '#94a3b8' : '#64748b'),
              }}>
                雲端（準確）
              </button>
              <button onClick={async () => {
                setSttMode('local');
                if (!sttModelStatus.ready) {
                  setSttDownloadProgress('準備本機模型...');
                  try {
                    await invoke('init_local_stt');
                    const status: any = await invoke('get_stt_model_status');
                    setSttModelStatus(status);
                    setSttDownloadProgress('');
                  } catch (err: any) {
                    setSttDownloadProgress(`失敗: ${err}`);
                  }
                }
              }} style={{
                flex: 1,
                padding: '6px 0',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                border: `2px solid ${sttMode === 'local' ? '#10b981' : (dark ? '#475569' : '#cbd5e1')}`,
                background: sttMode === 'local' ? 'rgba(16,185,129,0.2)' : 'transparent',
                color: sttMode === 'local' ? '#6ee7b7' : (dark ? '#94a3b8' : '#64748b'),
              }}>
                本機（快速）
              </button>
            </div>
            {sttDownloadProgress && (
              <div style={{ fontSize: 10, color: '#fbbf24', marginTop: 4 }}>
                {sttDownloadProgress}
              </div>
            )}
            <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>
              {sttMode === 'local'
                ? (sttModelStatus.ready ? '本機 Whisper 已就緒，無需上傳音訊' : '首次使用需下載 CLI + 模型 (~150MB)')
                : '使用 GPU 伺服器（Whisper large-v3），準確度最高'}
            </div>
          </div>

          {/* Logout */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={handleLogout}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 14px',
                borderRadius: 6,
                border: `1px solid ${dark ? '#475569' : '#e2e8f0'}`,
                background: 'transparent',
                color: '#ef4444',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'background 0.2s',
              }}
              onMouseOver={e => (e.currentTarget.style.background = dark ? '#1e293b' : '#fef2f2')}
              onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
            >
              <IconLogout />
              登出
            </button>
          </div>
        </div>
      )}

      {/* 首次啟動設定指南 */}
      {showSetupGuide && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 999,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            width: 420, padding: '28px 32px', borderRadius: 16,
            background: '#1e293b', boxShadow: '0 25px 60px rgba(0,0,0,0.5)',
          }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700, color: '#f1f5f9' }}>
              啟動前請先設定
            </h3>
            <div style={{ fontSize: 14, color: '#cbd5e1', lineHeight: 2 }}>
              <div style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.3)', color: '#fbbf24' }}>
                請先關閉 YouTube、音樂等其他播放音訊的程式，否則 AI 會聽到並回應那些聲音！
              </div>
              <p style={{ margin: '0 0 8px', fontWeight: 600 }}>使用建議：</p>
              <ol style={{ margin: '0 0 4px', paddingLeft: 20 }}>
                <li>開啟通話軟體（LINE / Zoom / Meet / Teams）</li>
                <li>開始通話後按下方「開始」</li>
                {mode >= 2 && <li>如已安裝 VB-Cable：在通話軟體<b>麥克風</b>選「CABLE Output」</li>}
                {mode === 3 && <li>如已安裝 OBS：在通話軟體<b>鏡頭</b>選「OBS Virtual Camera」</li>}
              </ol>
              <p style={{ margin: '8px 0 0', fontSize: 12, color: '#94a3b8' }}>
                即使沒有 VB-Cable，AI 也能聽取對方語音並在螢幕顯示回應。
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <button onClick={() => setShowSetupGuide(false)} style={{
                flex: 1, padding: '10px 0', borderRadius: 8,
                border: '1px solid #475569', background: 'transparent',
                color: '#94a3b8', fontSize: 14, fontWeight: 600, cursor: 'pointer',
              }}>取消</button>
              <button onClick={handleStart} style={{
                flex: 2, padding: '10px 0', borderRadius: 8,
                border: 'none', background: gradientBg,
                color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer',
              }}>已設定好，開始！</button>
            </div>
          </div>
        </div>
      )}

      {/* Main content area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* 啟動失敗錯誤訊息 */}
        {startError && status === 'idle' && (
          <div style={{
            margin: '12px 16px 0',
            padding: '12px 16px',
            borderRadius: 10,
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.3)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
          }}>
            <div style={{ color: '#ef4444', fontSize: 18, lineHeight: 1, flexShrink: 0, marginTop: 1 }}>!</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#fca5a5', marginBottom: 4 }}>啟動失敗</div>
              <div style={{ fontSize: 12, color: '#fca5a5', lineHeight: 1.5, wordBreak: 'break-all' }}>{startError}</div>
              {logs.length > 0 && (
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8, maxHeight: 120, overflowY: 'auto', lineHeight: 1.6 }}>
                  {logs.map((log, i) => (
                    <div key={i}>{log.text}</div>
                  ))}
                </div>
              )}
            </div>
            <button onClick={() => setStartError('')} style={{
              background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 16, padding: 0, lineHeight: 1,
            }}>x</button>
          </div>
        )}

        {/* Idle screen */}
        {status === 'idle' && !showSettings && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ textAlign: 'center', maxWidth: 400, padding: '0 20px' }}>
              <div style={{
                width: 100,
                height: 100,
                borderRadius: 50,
                margin: '0 auto 20px',
                background: gradientBg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <svg width="52" height="52" viewBox="0 0 52 52" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="14" y="6" width="24" height="32" rx="12" />
                  <circle cx="26" cy="22" r="4" />
                  <path d="M18 44h16" />
                  <path d="M26 38v6" />
                  <path d="M8 22a18 18 0 0036 0" />
                </svg>
              </div>
              <h2 style={{ margin: '0 0 8px', fontSize: 24 }}>AI 數位分身</h2>
              <p style={{ margin: '0 0 24px', color: '#64748b', fontSize: 14, lineHeight: 1.6 }}>
                一鍵啟動 AI 分身。接起 Zoom、Google Meet、Teams、LINE 任何視訊或通話，AI 會自動聽對方說話、用你的聲音和臉回應。
              </p>

              <button onClick={handleStartClick} style={{
                width: '100%',
                padding: '14px 0',
                borderRadius: 12,
                border: 'none',
                background: gradientBg,
                color: '#fff',
                fontSize: 18,
                fontWeight: 700,
                cursor: 'pointer',
                boxShadow: '0 4px 15px rgba(59,130,246,0.4)',
              }}>
                啟動分身
              </button>
            </div>
          </div>
        )}

        {/* Connecting: 顯示即時步驟 log */}
        {status === 'connecting' && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ textAlign: 'center', maxWidth: 420, padding: '0 20px' }}>
              <div style={{
                width: 50, height: 50,
                border: '3px solid #3b82f6', borderTopColor: 'transparent',
                borderRadius: 25, margin: '0 auto 16px',
                animation: 'spin 1s linear infinite',
              }} />
              <p style={{ color: '#f1f5f9', fontSize: 16, fontWeight: 600, marginBottom: 16 }}>啟動 AI 分身中...</p>
              <div style={{
                textAlign: 'left',
                fontSize: 12,
                color: '#94a3b8',
                lineHeight: 1.8,
                maxHeight: 200,
                overflowY: 'auto',
                background: 'rgba(15,23,42,0.5)',
                borderRadius: 8,
                padding: '10px 14px',
              }}>
                {logs.map((log, i) => (
                  <div key={i} style={{
                    color: log.text.includes('失敗') || log.text.includes('錯誤') ? '#fca5a5'
                      : log.text.includes('成功') || log.text.includes('完成') || log.text.includes('正常') ? '#86efac'
                      : '#94a3b8',
                  }}>
                    {log.text}
                  </div>
                ))}
              </div>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          </div>
        )}

        {/* Active: split view — left: avatar preview + controls, right: logs */}
        {status === 'active' && (
          <>
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

              {/* 左側：Avatar 影片預覽 + 控制按鈕 */}
              {isMode3 && (
                <div style={{
                  width: 300,
                  borderRight: '1px solid #334155',
                  display: 'flex',
                  flexDirection: 'column',
                  padding: 12,
                  gap: 10,
                  flexShrink: 0,
                }}>
                  {/* 影片預覽 */}
                  <div style={{
                    aspectRatio: '4/3',
                    background: '#000',
                    borderRadius: 8,
                    overflow: 'hidden',
                    position: 'relative',
                  }}>
                    {avatarVideoUrl ? (
                      <video
                        ref={avatarVideoRef}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        playsInline
                      />
                    ) : (
                      <div style={{
                        width: '100%',
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexDirection: 'column',
                        gap: 8,
                        color: '#475569',
                        fontSize: 12,
                      }}>
                        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="#334155" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="4" y="6" width="24" height="16" rx="3" />
                          <circle cx="16" cy="14" r="4" />
                          <path d="M10 26h12" />
                        </svg>
                        <span>等待 AI 回應影片...</span>
                      </div>
                    )}
                  </div>

                  {/* 虛擬鏡頭狀態 */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    borderRadius: 8,
                    background: obsStatus === 'running' ? 'rgba(59,130,246,0.15)' : '#1e293b',
                    border: `1px solid ${obsStatus === 'running' ? '#3b82f6' : '#334155'}`,
                  }}>
                    <IconCamera />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: obsStatus === 'running' ? '#60a5fa' : '#94a3b8' }}>
                        {obsStatus === 'running' ? '虛擬鏡頭運行中' : '虛擬鏡頭待機'}
                      </div>
                      {obsStatus === 'running' && (
                        <div style={{ fontSize: 10, color: '#fbbf24', marginTop: 2, fontWeight: 600 }}>
                          LINE 鏡頭 → OBS Virtual Camera
                          <br />
                          LINE 麥克風 → CABLE Output
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* 右側：即時日誌 */}
              <div style={{
                flex: 1,
                overflow: 'auto',
                padding: '12px 16px',
                fontSize: 13,
                lineHeight: 1.6,
              }}>
                {logs.map((log, i) => (
                  <div key={i} style={{
                    display: 'flex',
                    gap: 8,
                    marginBottom: 4,
                    opacity: log.type === 'system' ? 0.5 : 1,
                  }}>
                    <span style={{
                      color: '#64748b',
                      fontSize: 11,
                      fontFamily: 'monospace',
                      flexShrink: 0,
                      marginTop: 2,
                    }}>
                      {formatLogTime(log.timestamp)}
                    </span>
                    <span style={{
                      fontSize: 11,
                      fontWeight: 700,
                      flexShrink: 0,
                      marginTop: 2,
                      color: log.type === 'stt' ? '#38bdf8'
                        : log.type === 'ai-text' ? '#4ade80'
                        : log.type === 'ai-audio' ? '#c084fc'
                        : log.type === 'ai-video' ? '#fb923c'
                        : log.type === 'debug' ? '#fbbf24'
                        : '#64748b',
                    }}>
                      {log.type === 'stt' ? '[聽到]'
                        : log.type === 'ai-text' ? '[AI]'
                        : log.type === 'ai-audio' ? '[語音]'
                        : log.type === 'ai-video' ? '[影片]'
                        : log.type === 'debug' ? '[除錯]'
                        : '[系統]'}
                    </span>
                    <span>{log.text}</span>
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            </div>

            {/* Bottom control bar */}
            <div style={{
              padding: '10px 16px',
              borderTop: '1px solid #334155',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}>
              <div style={{ fontSize: 12, color: '#64748b', flexShrink: 0 }}>
                Mode {mode}{activeSceneId ? ` | ${scenes.find(s => s.id === activeSceneId)?.name || '場景'}` : ''} | {sessionId.slice(0, 8)}...
              </div>
              <form onSubmit={async (e) => {
                e.preventDefault();
                if (!manualText.trim()) return;
                addLog('stt', `手動輸入：${manualText}`);
                try {
                  await invoke('send_text', { text: manualText, mode });
                  addLog('system', '已送出到 AI');
                } catch (err: any) {
                  addLog('system', `送出失敗: ${err}`);
                }
                setManualText('');
              }} style={{ display: 'flex', gap: 6, flex: 1 }}>
                <input
                  value={manualText}
                  onChange={e => setManualText(e.target.value)}
                  placeholder="手動輸入文字測試 AI..."
                  style={{
                    flex: 1,
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: '1px solid #334155',
                    background: '#1e293b',
                    color: '#e2e8f0',
                    fontSize: 12,
                  }}
                />
                <button type="submit" style={{
                  padding: '6px 12px',
                  borderRadius: 6,
                  border: 'none',
                  background: '#3b82f6',
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  flexShrink: 0,
                }}>送出</button>
              </form>
              <button onClick={handleStop} style={{
                padding: '8px 24px',
                borderRadius: 8,
                border: 'none',
                background: '#ef4444',
                color: '#fff',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
                flexShrink: 0,
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
