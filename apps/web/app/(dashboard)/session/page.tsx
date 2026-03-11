'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { useMutation } from '@tanstack/react-query';
import { useSessionStore } from '@/lib/stores/session';
import { toast } from '@/components/Toast';
import { formatDuration } from '@/lib/utils';
import WebSocketPanel from './websocket-panel';

export default function SessionPage() {
  const {
    sessionId,
    status,
    startTime,
    mode,
    setSession,
    setStatus,
    setStartTime,
    setMode,
    clearSuggestions,
    reset,
  } = useSessionStore();

  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 計時器
  useEffect(() => {
    if (status === 'active' && startTime) {
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status, startTime]);

  const startMutation = useMutation({
    mutationFn: () => api.post('/api/v1/session/start'),
    onSuccess: (data) => {
      const id = data?.data?.sessionId || data?.data?.id;
      if (id) {
        setSession(id);
        setStatus('active');
        setStartTime(Date.now());
        setElapsed(0);
        clearSuggestions();
        toast.success('會議已開始');
      }
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '啟動會議失敗');
      setStatus('idle');
    },
  });

  const endMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/session/${id}/end`),
    onSuccess: () => {
      toast.success('會議已結束');
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setStatus('ended');
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '結束會議失敗');
    },
  });

  const handleStart = () => {
    setStatus('connecting');
    startMutation.mutate();
  };

  const handleEnd = () => {
    if (sessionId && window.confirm('確定要結束會議嗎？')) {
      endMutation.mutate(sessionId);
    }
  };

  const handleNewSession = () => {
    reset();
    setElapsed(0);
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-8 py-8 h-[calc(100vh-4rem)] flex flex-col">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">會議</h2>
        <div className="flex items-center gap-4">
          {/* 計時器 */}
          {(status === 'active' || status === 'ended') && (
            <div className="flex items-center gap-2 bg-gray-100 px-4 py-2 rounded-lg">
              <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="font-mono text-lg font-bold">
                {formatDuration(elapsed)}
              </span>
            </div>
          )}

          {/* 狀態指示 */}
          <span
            className={`text-xs px-3 py-1 rounded-full font-medium ${
              status === 'idle'
                ? 'bg-gray-100 text-gray-600'
                : status === 'connecting'
                ? 'bg-yellow-100 text-yellow-700'
                : status === 'active'
                ? 'bg-green-100 text-green-700'
                : 'bg-gray-100 text-gray-600'
            }`}
          >
            {status === 'idle'
              ? '待機中'
              : status === 'connecting'
              ? '連線中...'
              : status === 'active'
              ? '會議中'
              : '已結束'}
          </span>
        </div>
      </div>

      {/* 待機畫面 */}
      {status === 'idle' && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-24 h-24 mx-auto mb-6 bg-blue-100 rounded-full flex items-center justify-center">
              <svg className="w-12 h-12 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <h3 className="text-xl font-bold mb-2">AI 會議助手</h3>
            <p className="text-gray-500 mb-4 max-w-md">
              搭配 Zoom、Google Meet 或任何線上會議使用。
              開啟此視窗放在旁邊，AI 會即時提供回答建議。
            </p>
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 max-w-md mx-auto text-left">
              <p className="text-sm font-medium text-blue-800 mb-1">使用方式：</p>
              <ol className="text-xs text-blue-700 space-y-1 list-decimal list-inside">
                <li>打開 Zoom / Google Meet / Teams 加入會議</li>
                <li>在這裡選擇模式並點擊「開始會議」</li>
                <li>將對方說的話輸入（或用桌面版自動語音辨識）</li>
                <li>AI 即時給你回答建議，你決定是否採用</li>
              </ol>
            </div>

            {/* 模式選擇 */}
            <div className="grid grid-cols-3 gap-3 mb-6 max-w-lg mx-auto">
              <button
                onClick={() => setMode(1)}
                className={`p-3 rounded-xl border-2 text-left transition-all ${
                  mode === 1 ? 'border-blue-600 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="font-bold text-sm mb-1">Mode 1</div>
                <div className="text-xs text-gray-500">Prompt 提詞</div>
                <div className="text-xs text-gray-400 mt-1">AI 顯示建議文字，你自己講</div>
              </button>
              <button
                onClick={() => setMode(2)}
                className={`p-3 rounded-xl border-2 text-left transition-all ${
                  mode === 2 ? 'border-purple-600 bg-purple-50' : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="font-bold text-sm mb-1">Mode 2</div>
                <div className="text-xs text-gray-500">語音分身</div>
                <div className="text-xs text-gray-400 mt-1">AI 用你的聲音自動回答</div>
              </button>
              <button
                onClick={() => setMode(3)}
                className={`p-3 rounded-xl border-2 text-left transition-all ${
                  mode === 3 ? 'border-orange-600 bg-orange-50' : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="font-bold text-sm mb-1">Mode 3</div>
                <div className="text-xs text-gray-500">完整分身</div>
                <div className="text-xs text-gray-400 mt-1">AI 臉+聲音完全替你開會</div>
              </button>
            </div>
            {mode >= 2 && (
              <p className="text-xs text-amber-600 bg-amber-50 px-4 py-2 rounded-lg mb-4 max-w-md mx-auto">
                Mode {mode} 需要 GPU 服務運行中。語音會透過桌面版 App 播放到會議中。
              </p>
            )}

            <button
              onClick={handleStart}
              disabled={startMutation.isPending}
              className="px-8 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 font-medium text-lg shadow-lg"
            >
              {startMutation.isPending ? '啟動中...' : '開始會議'}
            </button>
          </div>
        </div>
      )}

      {/* 連線中 */}
      {status === 'connecting' && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4" />
            <p className="text-gray-600">正在建立會議連線...</p>
          </div>
        </div>
      )}

      {/* 活躍會議 */}
      {status === 'active' && sessionId && (
        <div className="flex-1 flex flex-col min-h-0 gap-4">
          {/* WebSocket Panel */}
          <div className="flex-1 min-h-0">
            <WebSocketPanel sessionId={sessionId} />
          </div>

          {/* 控制列 */}
          <div className="flex items-center justify-between bg-white rounded-xl shadow-sm border px-5 py-3">
            <div className="text-sm text-gray-500">
              會議 ID: <span className="font-mono">{sessionId.slice(0, 8)}...</span>
            </div>
            <button
              onClick={handleEnd}
              disabled={endMutation.isPending}
              className="px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium text-sm"
            >
              {endMutation.isPending ? '結束中...' : '結束會議'}
            </button>
          </div>
        </div>
      )}

      {/* 已結束 */}
      {status === 'ended' && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-24 h-24 mx-auto mb-6 bg-green-100 rounded-full flex items-center justify-center">
              <svg className="w-12 h-12 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h3 className="text-xl font-bold mb-2">會議已結束</h3>
            <p className="text-gray-500 mb-2">
              總時長：{formatDuration(elapsed)}
            </p>
            <p className="text-gray-500 mb-6">
              AI 共提供 {useSessionStore.getState().suggestions.length} 則建議
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={handleNewSession}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium text-sm"
              >
                新的會議
              </button>
              <a
                href="/dashboard"
                className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium"
              >
                返回儀表板
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
