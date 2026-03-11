'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { escapeHtml } from '@/lib/utils';

interface LogEntry {
  id: number;
  level: string;
  message: string;
  path: string;
  method: string;
  status: number;
  user_id: string;
  ip: string;
  created_at: string;
}

// TODO: 此頁面應限制為管理員存取（admin-only access）
export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<'all' | 'errors'>('all');
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await api.get(`/api/v1/logs?filter=${filter}&limit=200`);
      setLogs(res.data?.logs || []);
    } catch {
      // 靜默處理
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // 自動刷新
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs]);

  const clearLogs = async () => {
    if (!window.confirm('確定要清除所有日誌嗎？')) return;
    try {
      await api.delete('/api/v1/logs');
      setLogs([]);
    } catch {
      // 靜默處理
    }
  };

  const parseMessage = (msg: string): string => {
    try {
      const parsed = JSON.parse(msg);
      return parsed.error || parsed.message || msg;
    } catch {
      return msg.length > 200 ? msg.slice(0, 200) + '...' : msg;
    }
  };

  const statusColor = (status: number) => {
    if (status >= 500) return 'bg-red-100 text-red-800';
    if (status >= 400) return 'bg-yellow-100 text-yellow-800';
    return 'bg-green-100 text-green-800';
  };

  const levelIcon = (level: string) => {
    if (level === 'error') return '!';
    return '!';
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Error Monitor</h2>
        <div className="flex items-center gap-3">
          {/* 自動刷新 */}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            Auto-refresh (5s)
          </label>

          {/* 篩選 */}
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as 'all' | 'errors')}
            className="text-sm border rounded-lg px-3 py-1.5"
          >
            <option value="all">All (4xx+5xx)</option>
            <option value="errors">Errors (5xx only)</option>
          </select>

          <button
            onClick={fetchLogs}
            className="text-sm px-3 py-1.5 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100"
          >
            Refresh
          </button>
          <button
            onClick={clearLogs}
            className="text-sm px-3 py-1.5 bg-red-50 text-red-600 rounded-lg hover:bg-red-100"
          >
            Clear All
          </button>
        </div>
      </div>

      {/* 統計 */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl shadow-sm border p-4">
          <p className="text-sm text-gray-500">Total Logs</p>
          <p className="text-2xl font-bold">{logs.length}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border p-4">
          <p className="text-sm text-gray-500">5xx Errors</p>
          <p className="text-2xl font-bold text-red-600">
            {logs.filter((l) => l.status >= 500).length}
          </p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border p-4">
          <p className="text-sm text-gray-500">4xx Warnings</p>
          <p className="text-2xl font-bold text-yellow-600">
            {logs.filter((l) => l.status >= 400 && l.status < 500).length}
          </p>
        </div>
      </div>

      {/* 日誌列表 */}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400">Loading...</div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-center text-gray-400">No error logs</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left">
                <tr>
                  <th className="px-4 py-3 font-medium text-gray-600">Time</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Method</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Path</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Message</th>
                  <th className="px-4 py-3 font-medium text-gray-600">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {logs.map((log) => (
                  <tr
                    key={log.id}
                    className={`hover:bg-gray-50 ${
                      log.status >= 500 ? 'bg-red-50/50' : ''
                    }`}
                  >
                    <td className="px-4 py-3 whitespace-nowrap text-gray-500 font-mono text-xs">
                      {new Date(log.created_at).toLocaleString('zh-TW')}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusColor(
                          log.status
                        )}`}
                      >
                        {log.status >= 500 && (
                          <span className="w-3.5 h-3.5 rounded-full bg-red-500 text-white text-[10px] flex items-center justify-center font-bold">
                            {levelIcon(log.level)}
                          </span>
                        )}
                        {log.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs bg-gray-100 px-2 py-0.5 rounded">
                        {escapeHtml(log.method)}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-700 max-w-[200px] truncate">
                      {escapeHtml(log.path)}
                    </td>
                    <td className="px-4 py-3 text-gray-600 max-w-[300px] truncate">
                      {escapeHtml(parseMessage(log.message))}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-400">
                      {escapeHtml(log.ip)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
