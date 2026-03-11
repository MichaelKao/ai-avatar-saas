'use client';

import { useAuthStore } from '@/lib/stores/auth';
import { api } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';
import { escapeHtml, formatDate } from '@/lib/utils';
import Link from 'next/link';

interface SessionHistoryItem {
  id: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  total_responses: number;
}

interface BillingStatus {
  plan: string;
  status: string;
  current_period_end: string | null;
  usage_this_month: {
    sessions: number;
    total_minutes: number;
    suggestions: number;
  };
}

export default function DashboardPage() {
  const { user } = useAuthStore();

  const { data: billing, isLoading: billingLoading } = useQuery<BillingStatus>({
    queryKey: ['billing-status'],
    queryFn: () => api.get('/api/v1/billing/status').then((r) => r.data),
  });

  const { data: sessions, isLoading: sessionsLoading } = useQuery<SessionHistoryItem[]>({
    queryKey: ['session-history'],
    queryFn: () => api.get('/api/v1/session/history').then((r) => r.data?.sessions || []),
  });

  const usage = billing?.usage_this_month;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8">
      <h2 className="text-2xl font-bold mb-6">儀表板</h2>

      {/* 快速操作 */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Link
          href="/session"
          className="p-5 bg-blue-600 text-white rounded-xl shadow-sm hover:bg-blue-700 transition-colors"
        >
          <svg className="w-8 h-8 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <h3 className="font-bold mb-1">開始會議</h3>
          <p className="text-sm text-blue-100">啟動 AI 分身會議</p>
        </Link>

        <Link
          href="/avatar"
          className="p-5 bg-white rounded-xl shadow-sm border hover:shadow-md transition-shadow"
        >
          <svg className="w-8 h-8 mb-2 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <h3 className="font-bold mb-1">Avatar 設定</h3>
          <p className="text-sm text-gray-600">上傳照片、設定聲音</p>
        </Link>

        <Link
          href="/personality"
          className="p-5 bg-white rounded-xl shadow-sm border hover:shadow-md transition-shadow"
        >
          <svg className="w-8 h-8 mb-2 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
          <h3 className="font-bold mb-1">AI 個性設定</h3>
          <p className="text-sm text-gray-600">自訂 AI 回答風格</p>
        </Link>

        <Link
          href="/billing"
          className="p-5 bg-white rounded-xl shadow-sm border hover:shadow-md transition-shadow"
        >
          <svg className="w-8 h-8 mb-2 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
          </svg>
          <h3 className="font-bold mb-1">訂閱管理</h3>
          <p className="text-sm text-gray-600">管理你的方案</p>
        </Link>
      </div>

      {/* 使用狀態 */}
      <div className="bg-white rounded-xl shadow-sm border p-6 mb-8">
        <h3 className="font-bold mb-4">使用狀態</h3>
        {billingLoading ? (
          <div className="flex justify-center py-6">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="text-center p-3">
              <div className="text-3xl font-bold text-blue-600">
                {usage?.sessions ?? 0}
              </div>
              <div className="text-sm text-gray-500">本月會議</div>
            </div>
            <div className="text-center p-3">
              <div className="text-3xl font-bold text-green-600">
                {usage?.total_minutes ?? 0} 分鐘
              </div>
              <div className="text-sm text-gray-500">總使用時間</div>
            </div>
            <div className="text-center p-3">
              <div className="text-3xl font-bold text-purple-600">
                {usage?.suggestions ?? 0}
              </div>
              <div className="text-sm text-gray-500">AI 回覆數</div>
            </div>
            <div className="text-center p-3">
              <div className="text-3xl font-bold text-orange-600">
                {escapeHtml(billing?.plan || user?.plan || 'free')}
              </div>
              <div className="text-sm text-gray-500">目前方案</div>
            </div>
          </div>
        )}
      </div>

      {/* 最近會議 */}
      <div className="bg-white rounded-xl shadow-sm border p-6">
        <h3 className="font-bold mb-4">最近會議紀錄</h3>
        {sessionsLoading ? (
          <div className="flex justify-center py-6">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
          </div>
        ) : sessions && sessions.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="pb-2 pr-4">日期</th>
                  <th className="pb-2 pr-4">時長（分鐘）</th>
                  <th className="pb-2 pr-4">AI 回覆</th>
                  <th className="pb-2">狀態</th>
                </tr>
              </thead>
              <tbody>
                {sessions.slice(0, 10).map((s) => (
                  <tr key={s.id} className="border-b last:border-b-0">
                    <td className="py-3 pr-4">{formatDate(s.started_at)}</td>
                    <td className="py-3 pr-4">{Math.round((s.duration_seconds ?? 0) / 60)}</td>
                    <td className="py-3 pr-4">{s.total_responses}</td>
                    <td className="py-3">
                      <span
                        className={`inline-block text-xs px-2 py-0.5 rounded-full ${
                          s.ended_at
                            ? 'bg-gray-100 text-gray-600'
                            : 'bg-green-100 text-green-700'
                        }`}
                      >
                        {s.ended_at ? '已結束' : '進行中'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-gray-500 text-sm py-4">尚無會議紀錄。點擊「開始會議」來啟動第一場。</p>
        )}
      </div>
    </div>
  );
}
