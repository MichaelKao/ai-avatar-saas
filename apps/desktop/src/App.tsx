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

interface LogEntry {
  type: 'stt' | 'ai-text' | 'ai-audio' | 'ai-video' | 'system';
  text: string;
  timestamp: number;
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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [hasVideo, setHasVideo] = useState(false);

  useEffect(() => {
    const unlisten = listen<string>('avatar-video-update', (event) => {
      setVideoUrl(event.payload);
      setHasVideo(true);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  useEffect(() => {
    if (videoUrl && videoRef.current) {
      videoRef.current.src = videoUrl;
      videoRef.current.play().catch(() => {});
    }
  }, [videoUrl]);

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      background: '#000',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      cursor: 'default',
    }}>
      <video
        ref={videoRef}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: hasVideo ? 'block' : 'none',
        }}
        playsInline
      />
      {!hasVideo && (
        <div style={{
          color: '#475569',
          fontSize: 14,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          textAlign: 'center',
        }}>
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#334155" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12 }}>
            <rect x="8" y="10" width="32" height="24" rx="4" />
            <circle cx="24" cy="22" r="6" />
            <path d="M16 38h16" />
          </svg>
          <div>等待 AI Avatar 影片...</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LoginPage
// ---------------------------------------------------------------------------
function LoginPage({ apiUrl, onLogin }: { apiUrl: string; onLogin: (token: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email || !password) {
      setError('請輸入電子郵件和密碼');
      return;
    }
    setLoading(true);
    try {
      const body: any = await invoke('api_login', { apiUrl, email, password });
      const token = body.data?.token;
      if (!token) throw new Error('伺服器回傳格式異常，未取得 token');
      onLogin(token);
    } catch (err: any) {
      setError(typeof err === 'string' ? err : (err.message || '登入失敗'));
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
          <p style={{ margin: '6px 0 0', fontSize: 13, color: '#64748b' }}>登入您的帳號以繼續</p>
        </div>

        <form onSubmit={handleSubmit}>
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
              密碼
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
            {loading ? '登入中...' : '登入'}
          </button>
        </form>
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

  useEffect(() => {
    const unlisten = listen<string>('install-progress', (event) => {
      setProgressMsg(event.payload);
    });

    const run = async () => {
      try {
        const result: any = await invoke('auto_setup');
        if (result.vb_cable) {
          setProgressMsg('環境就緒！');
          setTimeout(() => onDone(), 500);
        } else {
          setError(result.message || 'VB-Cable 安裝失敗，請手動安裝後重啟 App');
        }
      } catch (e: any) {
        setError(typeof e === 'string' ? e : (e.message || '環境設定失敗'));
      }
    };
    run();

    return () => { unlisten.then(fn => fn()); };
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
              background: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </div>
            <h2 style={{ margin: '0 0 12px', fontSize: 20, fontWeight: 700 }}>設定未完成</h2>
            <p style={{ margin: '0 0 20px', color: '#f87171', fontSize: 14 }}>{error}</p>
            <button
              onClick={onDone}
              style={{
                padding: '10px 32px', borderRadius: 8,
                border: 'none', background: '#475569',
                color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
              }}
            >
              跳過，繼續使用
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------
function App() {
  // 判斷是否為 Avatar 獨立視窗
  const windowLabel = getCurrentWindow().label;
  if (windowLabel === 'avatar') {
    return <AvatarWindow />;
  }

  return <MainApp />;
}

function MainApp() {
  // Auth state
  const [token, setToken] = useState(() => localStorage.getItem('token') || '');
  const [setupDone, setSetupDone] = useState(() => localStorage.getItem('setupDone') === 'true');

  // Settings
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem('apiUrl') || 'https://ai-avatar-saas-production.up.railway.app');
  const [gpuUrl, setGpuUrl] = useState(() => localStorage.getItem('gpuUrl') || 'https://oq00jb5vt1laws-8888.proxy.runpod.net');
  const [mode, setMode] = useState(() => parseInt(localStorage.getItem('mode') || '3'));
  const [voiceGender, setVoiceGender] = useState<'male' | 'female'>(() => (localStorage.getItem('voiceGender') as any) || 'female');
  const [showSettings, setShowSettings] = useState(false);

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

  const screen: AppScreen = !token ? 'login' : !setupDone ? 'setup' : 'main';

  // -----------------------------------------------------------------------
  // Persist settings
  // -----------------------------------------------------------------------
  useEffect(() => {
    localStorage.setItem('apiUrl', apiUrl);
    localStorage.setItem('gpuUrl', gpuUrl);
    localStorage.setItem('mode', mode.toString());
    localStorage.setItem('voiceGender', voiceGender);
  }, [apiUrl, gpuUrl, mode, voiceGender]);

  useEffect(() => {
    if (token) localStorage.setItem('token', token);
    else localStorage.removeItem('token');
  }, [token]);

  useEffect(() => {
    localStorage.setItem('setupDone', setupDone ? 'true' : 'false');
  }, [setupDone]);

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
          addLog('ai-text', text);
        } else if (msg.type === 'tts_audio') {
          const audioUrl = msg.data?.audio_url || '';
          addLog('ai-audio', '語音回覆已產生');
          if (audioUrl) {
            invoke('play_audio_to_vbcable', { audioUrl }).then(() => {
              addLog('ai-audio', '語音已送出到虛擬麥克風');
            }).catch((err) => {
              // 不要用系統喇叭播放！否則 WASAPI loopback 會錄到產生回饋迴圈
              addLog('system', `VB-Cable 播放失敗: ${err}，請確認已安裝 VB-Cable`);
            });
          }
        } else if (msg.type === 'avatar_video') {
          const videoUrl = msg.data?.video_url || '';
          addLog('ai-video', '臉部動畫已產生');
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

    // OBS 安裝進度
    const unlisten4 = listen<string>('obs-install-progress', (event) => {
      addLog('system', event.payload);
    });

    return () => {
      unlisten1.then(fn => fn());
      unlisten2.then(fn => fn());
      unlisten3.then(fn => fn());
      unlisten4.then(fn => fn());
    };
  }, []);

  // -----------------------------------------------------------------------
  // 播放 Avatar 影片
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (avatarVideoUrl && avatarVideoRef.current) {
      avatarVideoRef.current.src = avatarVideoUrl;
      avatarVideoRef.current.play().catch(() => {});
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

  // 顯示設定指南後，確認再啟動
  const handleStartClick = () => {
    if (mode >= 2 && !localStorage.getItem('setupGuideShown')) {
      setShowSetupGuide(true);
      return;
    }
    handleStart();
  };

  const handleStart = async () => {
    setShowSetupGuide(false);
    localStorage.setItem('setupGuideShown', 'true');
    setStatus('connecting');
    setLogs([]);
    setElapsed(0);
    setAvatarVideoUrl('');
    addLog('system', '正在建立連線...');

    try {
      // 自動將 Windows 預設麥克風切換為 CABLE Output
      // 這樣 LINE/Zoom/Teams/Meet 全部自動使用虛擬麥克風，不需個別設定
      if (mode >= 2) {
        try {
          const micResult: string = await invoke('auto_set_default_mic');
          addLog('system', micResult);
        } catch (err: any) {
          addLog('system', `麥克風切換失敗: ${err}`);
        }
      }

      // 自動停用真實攝影機，讓 LINE/Zoom/Teams/Meet 只看到 OBS Virtual Camera
      try {
        const camResult: string = await invoke('auto_disable_real_cameras');
        addLog('system', camResult);
      } catch (err: any) {
        addLog('system', `攝影機設定: ${err}`);
      }

      // Mode 2/3：擷取 webcam 截圖 + 設定聲音性別
      let faceBase64 = '';
      if (mode >= 2) {
        addLog('system', '正在擷取臉部截圖...');
        faceBase64 = await captureWebcamFrame();
        if (faceBase64) {
          addLog('system', '臉部截圖完成');
        } else {
          addLog('system', '未偵測到攝影機，將使用預設臉部');
        }
        // 傳送聲音性別 + 臉部截圖到 Rust 後端
        await invoke('set_voice_and_face', {
          voiceGender,
          faceImageBase64: faceBase64,
        });
      }

      // Mode 3：自動設定虛擬鏡頭（OBS 全自動，使用者不需要操作）
      if (mode === 3) {
        addLog('system', '正在準備虛擬鏡頭環境...');
        await invoke('ensure_obs_ready');

        // 開啟 Avatar 視窗（給 OBS 擷取用）
        await invoke('open_avatar_window');
        await new Promise(r => setTimeout(r, 800));

        // 設定 OBS 場景 + 啟動虛擬鏡頭
        const obsResult: string = await invoke('start_obs_virtual_cam', { password: null });
        setObsStatus('running');
        addLog('system', obsResult);
      }

      addLog('system', '建立 AI 會議 Session...');
      let data: any;
      try {
        data = await invoke('api_start_session', { apiUrl, token });
      } catch (err: any) {
        if (err === 'TOKEN_EXPIRED') {
          addLog('system', 'Token 已過期，請重新登入');
          handleLogout();
          return;
        }
        throw new Error(typeof err === 'string' ? err : (err.message || '建立 Session 失敗'));
      }

      const sid = data.data?.sessionId || data.data?.id;
      if (!sid) throw new Error('無法取得 Session ID');
      setSessionId(sid);
      addLog('system', `Session 已建立: ${sid.slice(0, 8)}...`);

      addLog('system', '連接 WebSocket...');
      await invoke('connect_session', { apiUrl, token, sessionId: sid, mode });
      addLog('system', 'WebSocket 已連線');

      addLog('system', '啟動音訊擷取 + 語音辨識...');
      await invoke('start_auto_mode', { app: null, gpuUrl, mode });
      addLog('system', '自動模式已啟動 — AI 分身就緒！');

      setStatus('active');
    } catch (e: any) {
      addLog('system', `啟動失敗: ${e.message || e}`);
      setStatus('idle');
    }
  };

  const handleStop = async () => {
    try {
      await invoke('stop_auto_mode');
      await invoke('disconnect_session');
      invoke('close_avatar_window').catch(() => {});
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
              <p style={{ margin: '0 0 8px', fontWeight: 600 }}>請在通話軟體（LINE / Zoom / Meet）中設定：</p>
              <ol style={{ margin: '0 0 4px', paddingLeft: 20 }}>
                <li><b>麥克風</b> → 選擇「CABLE Output (VB-Audio Virtual Cable)」</li>
                <li><b>鏡頭</b> → 選擇「OBS Virtual Camera」</li>
              </ol>
              <p style={{ margin: '8px 0 0', fontSize: 12, color: '#94a3b8' }}>
                這樣 AI 的語音和畫面才會傳送給對方。設定完成後按下方按鈕開始。
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

        {/* Connecting spinner */}
        {status === 'connecting' && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                width: 60,
                height: 60,
                border: '3px solid #3b82f6',
                borderTopColor: 'transparent',
                borderRadius: 30,
                margin: '0 auto 16px',
                animation: 'spin 1s linear infinite',
              }} />
              <p style={{ color: '#64748b', fontSize: 16 }}>啟動 AI 分身中...</p>
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
            </div>

            {/* Bottom control bar */}
            <div style={{
              padding: '10px 16px',
              borderTop: '1px solid #334155',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <div style={{ fontSize: 12, color: '#64748b' }}>
                Mode {mode} | Session: {sessionId.slice(0, 8)}...
              </div>
              <button onClick={handleStop} style={{
                padding: '8px 24px',
                borderRadius: 8,
                border: 'none',
                background: '#ef4444',
                color: '#fff',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
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
