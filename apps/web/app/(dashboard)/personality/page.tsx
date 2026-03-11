'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { escapeHtml } from '@/lib/utils';
import { toast } from '@/components/Toast';

interface Personality {
  id: string;
  name: string;
  system_prompt: string;
  llm_model: string;
  temperature: number;
  is_default: boolean;
  created_at: string;
}

interface PersonalityForm {
  name: string;
  system_prompt: string;
  llm_model: string;
  temperature: number;
  language: string;
}

const defaultForm: PersonalityForm = {
  name: '',
  system_prompt: '',
  llm_model: 'claude-sonnet-4-20250514',
  temperature: 0.7,
  language: 'zh-TW',
};

const modelOptions = [
  { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { value: 'gpt-4o', label: 'GPT-4o' },
  { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
];

export default function PersonalityPage() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PersonalityForm>(defaultForm);

  const { data: personalities = [], isLoading } = useQuery<Personality[]>({
    queryKey: ['personalities'],
    queryFn: () => api.get('/api/v1/personality').then((r) => r.data || []),
  });

  const createMutation = useMutation({
    mutationFn: (data: PersonalityForm) => api.post('/api/v1/personality', data),
    onSuccess: () => {
      toast.success('AI 個性已建立');
      queryClient.invalidateQueries({ queryKey: ['personalities'] });
      resetForm();
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '建立失敗');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: PersonalityForm }) =>
      api.put(`/api/v1/personality/${id}`, data),
    onSuccess: () => {
      toast.success('AI 個性已更新');
      queryClient.invalidateQueries({ queryKey: ['personalities'] });
      resetForm();
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '更新失敗');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/personality/${id}`),
    onSuccess: () => {
      toast.success('AI 個性已刪除');
      queryClient.invalidateQueries({ queryKey: ['personalities'] });
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '刪除失敗');
    },
  });

  const setDefaultMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/personality/${id}/set-default`),
    onSuccess: () => {
      toast.success('已設為預設個性');
      queryClient.invalidateQueries({ queryKey: ['personalities'] });
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '設定失敗');
    },
  });

  const resetForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(defaultForm);
  };

  const startEdit = (p: Personality) => {
    setEditingId(p.id);
    setForm({
      name: p.name,
      system_prompt: p.system_prompt,
      llm_model: p.llm_model,
      temperature: p.temperature,
      language: 'zh-TW',
    });
    setShowForm(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.system_prompt.trim()) {
      toast.error('請填寫名稱和系統提示詞');
      return;
    }
    if (editingId) {
      updateMutation.mutate({ id: editingId, data: form });
    } else {
      createMutation.mutate(form);
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">AI 個性設定</h2>
        {!showForm && (
          <button
            onClick={() => {
              resetForm();
              setShowForm(true);
            }}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
          >
            新增個性
          </button>
        )}
      </div>

      {/* 表單 */}
      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
          <h3 className="font-bold mb-4">
            {editingId ? '編輯個性' : '新增個性'}
          </h3>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                個性名稱
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="例如：專業顧問"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                系統提示詞
              </label>
              <textarea
                value={form.system_prompt}
                onChange={(e) =>
                  setForm({ ...form, system_prompt: e.target.value })
                }
                rows={5}
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="描述 AI 的角色和回答風格..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                AI 模型
              </label>
              <select
                value={form.llm_model}
                onChange={(e) => setForm({ ...form, llm_model: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {modelOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                溫度 (Temperature): {form.temperature}
              </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={form.temperature}
                onChange={(e) =>
                  setForm({ ...form, temperature: parseFloat(e.target.value) })
                }
                className="w-full"
              />
              <div className="flex justify-between text-xs text-gray-500">
                <span>精確</span>
                <span>創意</span>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={isSaving}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium text-sm"
              >
                {isSaving ? '儲存中...' : editingId ? '更新' : '建立'}
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm"
              >
                取消
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 個性列表 */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : personalities.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border p-8 text-center">
          <p className="text-gray-500 mb-4">尚未建立任何 AI 個性。</p>
          {!showForm && (
            <button
              onClick={() => setShowForm(true)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
            >
              建立第一個
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {personalities.map((p) => (
            <div
              key={p.id}
              className={`bg-white rounded-xl shadow-sm border p-5 ${
                p.is_default ? 'border-blue-300 ring-1 ring-blue-200' : ''
              }`}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <h4 className="font-bold">{escapeHtml(p.name)}</h4>
                  {p.is_default && (
                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                      預設
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {!p.is_default && (
                    <button
                      onClick={() => setDefaultMutation.mutate(p.id)}
                      disabled={setDefaultMutation.isPending}
                      className="text-xs text-blue-600 hover:text-blue-800"
                    >
                      設為預設
                    </button>
                  )}
                  <button
                    onClick={() => startEdit(p)}
                    className="text-xs text-gray-600 hover:text-gray-800"
                  >
                    編輯
                  </button>
                  <button
                    onClick={() => {
                      if (
                        window.confirm(
                          `確定要刪除「${p.name}」嗎？`
                        )
                      ) {
                        deleteMutation.mutate(p.id);
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    className="text-xs text-red-600 hover:text-red-800"
                  >
                    刪除
                  </button>
                </div>
              </div>
              <p className="text-sm text-gray-600 mb-2 line-clamp-2">
                {escapeHtml(p.system_prompt)}
              </p>
              <div className="flex gap-4 text-xs text-gray-500">
                <span>
                  模型:{' '}
                  {escapeHtml(
                    modelOptions.find((m) => m.value === p.llm_model)?.label ||
                      p.llm_model
                  )}
                </span>
                <span>溫度: {p.temperature}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
