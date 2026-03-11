'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useSessionStore, type AiSuggestion } from '@/lib/stores/session';
import { escapeHtml } from '@/lib/utils';

const WS_BASE = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080')
  .replace(/^http/, 'ws');

interface WebSocketPanelProps {
  sessionId: string;
}

export default function WebSocketPanel({ sessionId }: WebSocketPanelProps) {
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [inputText, setInputText] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const {
    wsConnected,
    setWsConnected,
    suggestions,
    addSuggestion,
    mode,
  } = useSessionStore();

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const token = localStorage.getItem('auth-token') || '';
    const url = `${WS_BASE}/ws/session/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);

    ws.onopen = () => {
      setWsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'suggestion_text' || msg.type === 'suggestion' || msg.type === 'ai_response') {
          const text = msg.data?.text || msg.text || msg.content || JSON.stringify(msg.data);
          addSuggestion({
            id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
            text,
            timestamp: Date.now(),
          });
        } else if (msg.type === 'thinking_animation') {
          setIsThinking(msg.data?.status === 'start');
        } else if (msg.type === 'tts_audio') {
          // Mode 2/3: 收到 TTS 語音
          addSuggestion({
            id: 'tts-' + Date.now(),
            text: '[TTS 語音已生成]',
            timestamp: Date.now(),
          });
        } else if (msg.type === 'connected') {
          // 連線成功
        } else if (msg.type === 'error') {
          addSuggestion({
            id: 'err-' + Date.now(),
            text: `[錯誤] ${msg.data || '未知錯誤'}`,
            timestamp: Date.now(),
          });
        }
      } catch {
        addSuggestion({
          id: Date.now().toString(),
          text: event.data,
          timestamp: Date.now(),
        });
      }
    };

    ws.onclose = () => {
      setWsConnected(false);
    };

    ws.onerror = () => {
      setWsConnected(false);
    };

    wsRef.current = ws;
  }, [sessionId, setWsConnected, addSuggestion]);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setWsConnected(false);
  }, [setWsConnected]);

  // 自動連線
  useEffect(() => {
    connect();
    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  // 自動捲動
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [suggestions]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(
      JSON.stringify({
        text: inputText.trim(),
        mode: mode,
      })
    );
    setInputText('');
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border flex flex-col h-full">
      {/* 標題 & 連線狀態 */}
      <div className="flex items-center justify-between px-5 py-3 border-b">
        <div className="flex items-center gap-2">
          <h3 className="font-bold text-sm">AI 即時建議</h3>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            mode === 1 ? 'bg-blue-100 text-blue-700' :
            mode === 2 ? 'bg-purple-100 text-purple-700' :
            'bg-orange-100 text-orange-700'
          }`}>
            Mode {mode}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs">
            <span
              className={`w-2 h-2 rounded-full ${
                wsConnected ? 'bg-green-500' : 'bg-red-500'
              }`}
            />
            {wsConnected ? '已連線' : '未連線'}
          </span>
          <button
            onClick={wsConnected ? disconnect : connect}
            className={`text-xs px-3 py-1 rounded font-medium ${
              wsConnected
                ? 'bg-red-50 text-red-600 hover:bg-red-100'
                : 'bg-green-50 text-green-600 hover:bg-green-100'
            }`}
          >
            {wsConnected ? '中斷' : '連線'}
          </button>
        </div>
      </div>

      {/* 訊息區 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
        {suggestions.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-8">
            等待 AI 回覆...
          </p>
        ) : (
          suggestions.map((s) => (
            <div key={s.id} className="bg-blue-50 rounded-lg p-3">
              <p className="text-sm text-gray-800 whitespace-pre-wrap">
                {escapeHtml(s.text)}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                {new Date(s.timestamp).toLocaleTimeString('zh-TW')}
              </p>
            </div>
          ))
        )}
        {isThinking && (
          <div className="flex items-center gap-2 text-sm text-gray-400 py-2">
            <div className="flex gap-1">
              <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            AI 思考中...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 輸入區 */}
      <form
        onSubmit={handleSend}
        className="border-t px-4 py-3 flex gap-2"
      >
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="輸入文字模擬語音轉文字..."
          className="flex-1 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          disabled={!wsConnected}
        />
        <button
          type="submit"
          disabled={!wsConnected || !inputText.trim()}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium flex-shrink-0"
        >
          傳送
        </button>
      </form>
    </div>
  );
}
