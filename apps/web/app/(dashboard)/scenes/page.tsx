'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { escapeHtml } from '@/lib/utils';
import { toast } from '@/components/Toast';

interface Scene {
  id: string;
  name: string;
  scene_type: string;
  language: string;
  reply_language: string;
  reply_length: string;
  personality: string;
  formality: number;
  custom_system_prompt: string | null;
  llm_model: string;
  temperature: number;
  transition_enabled: boolean;
  transition_style: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

interface SceneTemplate {
  scene_type: string;
  name: string;
  description: string;
  personality: string;
  reply_length: string;
  formality: number;
  default_system_prompt: string;
}

const templateIcons: Record<string, string> = {
  interview: 'M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  business_meeting: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  customer_service: 'M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z',
  academic: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
  casual: 'M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  custom: 'M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z',
};

const templateColors: Record<string, string> = {
  interview: 'bg-blue-50 text-blue-600 border-blue-200',
  business_meeting: 'bg-purple-50 text-purple-600 border-purple-200',
  customer_service: 'bg-green-50 text-green-600 border-green-200',
  academic: 'bg-orange-50 text-orange-600 border-orange-200',
  casual: 'bg-pink-50 text-pink-600 border-pink-200',
  custom: 'bg-gray-50 text-gray-600 border-gray-200',
};

const sceneTypeLabels: Record<string, string> = {
  interview: '技術面試',
  business_meeting: '商務會議',
  customer_service: '客戶服務',
  academic: '學術討論',
  casual: '日常對話',
  custom: '自訂場景',
};

export default function ScenesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);

  // 取得場景列表
  const { data: scenes = [], isLoading } = useQuery<Scene[]>({
    queryKey: ['scenes'],
    queryFn: () => api.get('/api/v1/scenes').then((r) => r.data || []),
  });

  // 取得場景模板
  const { data: templates = [] } = useQuery<SceneTemplate[]>({
    queryKey: ['scene-templates'],
    queryFn: () => api.get('/api/v1/scenes/templates').then((r) => r.data || []),
  });

  // 建立場景
  const createMutation = useMutation({
    mutationFn: (data: { name: string; scene_type: string }) =>
      api.post('/api/v1/scenes', data),
    onSuccess: (res) => {
      toast.success('場景已建立');
      queryClient.invalidateQueries({ queryKey: ['scenes'] });
      setShowCreate(false);
      setNewName('');
      setSelectedTemplate(null);
      if (res.data?.id) {
        router.push(`/scenes/${res.data.id}`);
      }
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '建立失敗');
    },
  });

  // 刪除場景
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/scenes/${id}`),
    onSuccess: () => {
      toast.success('場景已刪除');
      queryClient.invalidateQueries({ queryKey: ['scenes'] });
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '刪除失敗');
    },
  });

  // 設為預設
  const setDefaultMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/scenes/${id}/set-default`),
    onSuccess: () => {
      toast.success('已設為預設場景');
      queryClient.invalidateQueries({ queryKey: ['scenes'] });
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '設定失敗');
    },
  });

  const handleCreate = () => {
    if (!newName.trim()) {
      toast.error('請輸入場景名稱');
      return;
    }
    createMutation.mutate({
      name: newName,
      scene_type: selectedTemplate || 'custom',
    });
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-8 py-8">
      {/* 標題 */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">場景管理</h1>
          <p className="text-sm text-gray-500 mt-1">
            建立不同場景，每個場景有獨立的 AI 設定、知識庫和個人背景
          </p>
        </div>
        {!showCreate && (
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            新增場景
          </button>
        )}
      </div>

      {/* 建立場景 */}
      {showCreate && (
        <div className="bg-white rounded-xl shadow-sm border p-6 mb-8">
          <h3 className="font-bold text-lg mb-4">選擇場景模板</h3>

          {/* 模板選擇格 */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
            {templates.map((t) => {
              const isSelected = selectedTemplate === t.scene_type;
              const colors = templateColors[t.scene_type] || templateColors.custom;
              return (
                <button
                  key={t.scene_type}
                  onClick={() => {
                    setSelectedTemplate(t.scene_type);
                    if (!newName) setNewName(t.name);
                  }}
                  className={`p-4 rounded-xl border-2 text-left transition-all ${
                    isSelected
                      ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
                      : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <div
                    className={`w-10 h-10 rounded-lg flex items-center justify-center mb-3 ${colors}`}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d={templateIcons[t.scene_type] || templateIcons.custom}
                      />
                    </svg>
                  </div>
                  <p className="font-medium text-sm text-gray-900">{escapeHtml(t.name)}</p>
                  <p className="text-xs text-gray-500 mt-1 line-clamp-2">
                    {escapeHtml(t.description)}
                  </p>
                </button>
              );
            })}
          </div>

          {/* 場景名稱 */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              場景名稱
            </label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="例如：前端工程師面試"
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleCreate}
              disabled={createMutation.isPending}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium text-sm"
            >
              {createMutation.isPending ? '建立中...' : '建立場景'}
            </button>
            <button
              onClick={() => {
                setShowCreate(false);
                setNewName('');
                setSelectedTemplate(null);
              }}
              className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 場景卡片列表 */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : scenes.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border p-12 text-center">
          <div className="w-16 h-16 mx-auto mb-4 bg-gray-100 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <p className="text-gray-500 mb-4">尚未建立任何場景</p>
          {!showCreate && (
            <button
              onClick={() => setShowCreate(true)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
            >
              建立第一個場景
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {scenes.map((s) => {
            const colors = templateColors[s.scene_type] || templateColors.custom;
            return (
              <div
                key={s.id}
                className={`bg-white rounded-xl shadow-sm border p-5 hover:shadow-md transition-shadow cursor-pointer relative group ${
                  s.is_default ? 'border-blue-300 ring-1 ring-blue-200' : ''
                }`}
                onClick={() => router.push(`/scenes/${s.id}`)}
              >
                {/* 預設標籤 */}
                {s.is_default && (
                  <span className="absolute top-3 right-3 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                    預設
                  </span>
                )}

                {/* 圖標 + 類型 */}
                <div className="flex items-center gap-3 mb-3">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${colors}`}>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d={templateIcons[s.scene_type] || templateIcons.custom}
                      />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-gray-900 truncate">{escapeHtml(s.name)}</h3>
                    <p className="text-xs text-gray-500">
                      {sceneTypeLabels[s.scene_type] || s.scene_type}
                    </p>
                  </div>
                </div>

                {/* 設定摘要 */}
                <div className="flex flex-wrap gap-1.5 mb-4">
                  <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full">
                    {s.language}
                  </span>
                  <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full">
                    {s.reply_length === 'short' ? '簡短' : s.reply_length === 'long' ? '詳細' : '中等'}
                  </span>
                  <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full">
                    正式度 {s.formality}/5
                  </span>
                </div>

                {/* 操作按鈕 */}
                <div
                  className="flex items-center gap-2 pt-3 border-t border-gray-100"
                  onClick={(e) => e.stopPropagation()}
                >
                  {!s.is_default && (
                    <button
                      onClick={() => setDefaultMutation.mutate(s.id)}
                      disabled={setDefaultMutation.isPending}
                      className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                    >
                      設為預設
                    </button>
                  )}
                  <button
                    onClick={() => router.push(`/scenes/${s.id}`)}
                    className="text-xs text-gray-600 hover:text-gray-800 font-medium"
                  >
                    編輯
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm(`確定要刪除「${s.name}」嗎？`)) {
                        deleteMutation.mutate(s.id);
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    className="text-xs text-red-600 hover:text-red-800 font-medium ml-auto"
                  >
                    刪除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
