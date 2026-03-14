'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { escapeHtml } from '@/lib/utils';
import { toast } from '@/components/Toast';

// ─── 型別定義 ───────────────────────────────────────────

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
}

interface KnowledgeBase {
  id: string;
  title: string;
  content: string;
  content_type: string;
  token_count: number;
  created_at: string;
}

interface UserProfile {
  id: string;
  display_name: string | null;
  title: string | null;
  company: string | null;
  experience_years: number;
  skills: string | null;
  experiences: string | null;
  custom_phrases: string | null;
  additional_context: string | null;
}

// ─── 常數 ───────────────────────────────────────────────

const tabs = [
  { key: 'basic', label: '基本設定', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z' },
  { key: 'knowledge', label: '知識庫', icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253' },
  { key: 'profile', label: '個人背景', icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z' },
  { key: 'voice', label: '聲音設定', icon: 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z' },
  { key: 'transition', label: '過渡語', icon: 'M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z' },
];

const modelOptions = [
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'gpt-4o', label: 'GPT-4o' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
];

const personalityOptions = [
  { value: 'professional', label: '專業穩重' },
  { value: 'confident', label: '自信果斷' },
  { value: 'friendly', label: '親切友善' },
  { value: 'rigorous', label: '嚴謹學術' },
  { value: 'casual', label: '輕鬆自然' },
];

const languageOptions = [
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'zh-CN', label: '簡體中文' },
  { value: 'en-US', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
];

const replyLengthOptions = [
  { value: 'short', label: '簡短 (1-2句)' },
  { value: 'medium', label: '中等 (2-3句)' },
  { value: 'long', label: '詳細 (4-5句)' },
];

// ─── 主元件 ─────────────────────────────────────────────

export default function SceneDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('basic');

  // 取得場景
  const { data: scenes = [] } = useQuery<Scene[]>({
    queryKey: ['scenes'],
    queryFn: () => api.get('/api/v1/scenes').then((r) => r.data || []),
  });
  const scene = scenes.find((s) => s.id === id);

  // 取得知識庫
  const { data: kbItems = [], isLoading: kbLoading } = useQuery<KnowledgeBase[]>({
    queryKey: ['knowledge', id],
    queryFn: () => api.get(`/api/v1/scenes/${id}/knowledge`).then((r) => r.data || []),
    enabled: !!id,
  });

  // 取得用戶背景
  const { data: profileData } = useQuery<UserProfile | null>({
    queryKey: ['profile', id],
    queryFn: () => api.get(`/api/v1/scenes/${id}/profile`).then((r) => r.data || null),
    enabled: !!id,
  });

  if (!scene) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-8 py-8">
      {/* 頂部導航 */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => router.push('/scenes')}
          className="text-gray-500 hover:text-gray-700"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{escapeHtml(scene.name)}</h1>
          <p className="text-sm text-gray-500">場景設定</p>
        </div>
        {scene.is_default && (
          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
            預設
          </span>
        )}
      </div>

      {/* Tab 列 */}
      <div className="border-b border-gray-200 mb-6 overflow-x-auto">
        <div className="flex gap-1 min-w-max">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.key
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={tab.icon} />
              </svg>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab 內容 */}
      {activeTab === 'basic' && <BasicTab scene={scene} />}
      {activeTab === 'knowledge' && (
        <KnowledgeTab sceneId={id} items={kbItems} isLoading={kbLoading} />
      )}
      {activeTab === 'profile' && <ProfileTab sceneId={id} profile={profileData ?? null} />}
      {activeTab === 'voice' && <VoiceTab />}
      {activeTab === 'transition' && <TransitionTab scene={scene} />}
    </div>
  );
}

// ─── Tab 1: 基本設定 ────────────────────────────────────

function BasicTab({ scene }: { scene: Scene }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: scene.name,
    language: scene.language,
    reply_language: scene.reply_language,
    reply_length: scene.reply_length,
    personality: scene.personality,
    formality: scene.formality,
    llm_model: scene.llm_model,
    temperature: scene.temperature,
    custom_system_prompt: scene.custom_system_prompt || '',
  });

  const updateMutation = useMutation({
    mutationFn: (data: typeof form) => api.put(`/api/v1/scenes/${scene.id}`, data),
    onSuccess: () => {
      toast.success('場景已更新');
      queryClient.invalidateQueries({ queryKey: ['scenes'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || '更新失敗'),
  });

  return (
    <div className="bg-white rounded-xl shadow-sm border p-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          updateMutation.mutate(form);
        }}
        className="space-y-5"
      >
        {/* 場景名稱 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">場景名稱</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        {/* 語言 + 回覆語言 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">輸入語言</label>
            <select
              value={form.language}
              onChange={(e) => setForm({ ...form, language: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {languageOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">回覆語言</label>
            <select
              value={form.reply_language}
              onChange={(e) => setForm({ ...form, reply_language: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {languageOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* 回答長度 + 個性 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">回答長度</label>
            <select
              value={form.reply_length}
              onChange={(e) => setForm({ ...form, reply_length: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {replyLengthOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">AI 個性</label>
            <select
              value={form.personality}
              onChange={(e) => setForm({ ...form, personality: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {personalityOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* 正式度 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            正式度: {form.formality}/5
          </label>
          <input
            type="range"
            min="1"
            max="5"
            step="1"
            value={form.formality}
            onChange={(e) => setForm({ ...form, formality: parseInt(e.target.value) })}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-gray-500">
            <span>輕鬆</span>
            <span>正式</span>
          </div>
        </div>

        {/* AI 模型 + 溫度 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">AI 模型</label>
            <select
              value={form.llm_model}
              onChange={(e) => setForm({ ...form, llm_model: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {modelOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              溫度: {form.temperature}
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={form.temperature}
              onChange={(e) => setForm({ ...form, temperature: parseFloat(e.target.value) })}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-gray-500">
              <span>精確</span>
              <span>創意</span>
            </div>
          </div>
        </div>

        {/* 自訂 System Prompt */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            自訂 System Prompt <span className="text-gray-400 font-normal">(選填)</span>
          </label>
          <textarea
            value={form.custom_system_prompt}
            onChange={(e) => setForm({ ...form, custom_system_prompt: e.target.value })}
            rows={4}
            className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="留空則使用模板預設 prompt"
          />
        </div>

        <button
          type="submit"
          disabled={updateMutation.isPending}
          className="px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium text-sm"
        >
          {updateMutation.isPending ? '儲存中...' : '儲存設定'}
        </button>
      </form>
    </div>
  );
}

// ─── Tab 2: 知識庫 ──────────────────────────────────────

function KnowledgeTab({
  sceneId,
  items,
  isLoading,
}: {
  sceneId: string;
  items: KnowledgeBase[];
  isLoading: boolean;
}) {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ title: '', content: '', content_type: 'text' });

  const createMutation = useMutation({
    mutationFn: (data: typeof form) => api.post(`/api/v1/scenes/${sceneId}/knowledge`, data),
    onSuccess: () => {
      toast.success('知識庫已新增');
      queryClient.invalidateQueries({ queryKey: ['knowledge', sceneId] });
      setShowAdd(false);
      setForm({ title: '', content: '', content_type: 'text' });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || '新增失敗'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { title: string; content: string } }) =>
      api.put(`/api/v1/scenes/knowledge/${id}`, data),
    onSuccess: () => {
      toast.success('知識庫已更新');
      queryClient.invalidateQueries({ queryKey: ['knowledge', sceneId] });
      setEditId(null);
    },
    onError: (err: any) => toast.error(err.response?.data?.error || '更新失敗'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/scenes/knowledge/${id}`),
    onSuccess: () => {
      toast.success('知識庫已刪除');
      queryClient.invalidateQueries({ queryKey: ['knowledge', sceneId] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || '刪除失敗'),
  });

  const startEdit = (item: KnowledgeBase) => {
    setEditId(item.id);
    setForm({ title: item.title, content: item.content, content_type: item.content_type });
    setShowAdd(true);
  };

  return (
    <div>
      {/* 新增/編輯表單 */}
      {showAdd ? (
        <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
          <h3 className="font-bold mb-4">{editId ? '編輯知識庫' : '新增知識庫'}</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">標題</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="例如：公司產品介紹"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">內容</label>
              <textarea
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                rows={8}
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="貼上知識內容，AI 回答時會參考這些資料..."
              />
              <p className="text-xs text-gray-400 mt-1">
                預估 Token: ~{Math.ceil(form.content.length / 2)}
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  if (!form.title.trim() || !form.content.trim()) {
                    toast.error('標題和內容為必填');
                    return;
                  }
                  if (editId) {
                    updateMutation.mutate({ id: editId, data: { title: form.title, content: form.content } });
                  } else {
                    createMutation.mutate(form);
                  }
                }}
                disabled={createMutation.isPending || updateMutation.isPending}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium text-sm"
              >
                {createMutation.isPending || updateMutation.isPending ? '儲存中...' : editId ? '更新' : '新增'}
              </button>
              <button
                onClick={() => {
                  setShowAdd(false);
                  setEditId(null);
                  setForm({ title: '', content: '', content_type: 'text' });
                }}
                className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          onClick={() => {
            setEditId(null);
            setForm({ title: '', content: '', content_type: 'text' });
            setShowAdd(true);
          }}
          className="mb-6 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          新增知識
        </button>
      )}

      {/* 知識列表 */}
      {isLoading ? (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border p-8 text-center">
          <p className="text-gray-500">尚未新增任何知識庫資料</p>
          <p className="text-xs text-gray-400 mt-1">新增知識後，AI 回答時會參考這些內容</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.id} className="bg-white rounded-xl shadow-sm border p-5">
              <div className="flex items-start justify-between mb-2">
                <h4 className="font-bold text-gray-900">{escapeHtml(item.title)}</h4>
                <div className="flex items-center gap-2 flex-shrink-0 ml-4">
                  <button
                    onClick={() => startEdit(item)}
                    className="text-xs text-gray-600 hover:text-gray-800"
                  >
                    編輯
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm('確定要刪除？')) deleteMutation.mutate(item.id);
                    }}
                    className="text-xs text-red-600 hover:text-red-800"
                  >
                    刪除
                  </button>
                </div>
              </div>
              <p className="text-sm text-gray-600 line-clamp-3">{escapeHtml(item.content)}</p>
              <p className="text-xs text-gray-400 mt-2">~{item.token_count} tokens</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Tab 3: 個人背景 ────────────────────────────────────

function ProfileTab({ sceneId, profile }: { sceneId: string; profile: UserProfile | null }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    display_name: profile?.display_name || '',
    title: profile?.title || '',
    company: profile?.company || '',
    experience_years: profile?.experience_years || 0,
    skills: profile?.skills || '',
    experiences: profile?.experiences || '',
    custom_phrases: profile?.custom_phrases || '',
    additional_context: profile?.additional_context || '',
  });

  const upsertMutation = useMutation({
    mutationFn: (data: typeof form) => api.put(`/api/v1/scenes/${sceneId}/profile`, data),
    onSuccess: () => {
      toast.success('個人背景已儲存');
      queryClient.invalidateQueries({ queryKey: ['profile', sceneId] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || '儲存失敗'),
  });

  return (
    <div className="bg-white rounded-xl shadow-sm border p-6">
      <p className="text-sm text-gray-500 mb-5">
        填入你的背景資訊，AI 回答時會以你的身份自稱
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          upsertMutation.mutate(form);
        }}
        className="space-y-5"
      >
        {/* 名稱 + 職位 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">顯示名稱</label>
            <input
              type="text"
              value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="你的名字"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">職位</label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="例如：資深前端工程師"
            />
          </div>
        </div>

        {/* 公司 + 年資 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">公司</label>
            <input
              type="text"
              value={form.company}
              onChange={(e) => setForm({ ...form, company: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="目前任職公司"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              工作年資: {form.experience_years} 年
            </label>
            <input
              type="range"
              min="0"
              max="30"
              step="1"
              value={form.experience_years}
              onChange={(e) => setForm({ ...form, experience_years: parseInt(e.target.value) })}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-gray-500">
              <span>應屆</span>
              <span>30+ 年</span>
            </div>
          </div>
        </div>

        {/* 技能 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">技能專長</label>
          <textarea
            value={form.skills}
            onChange={(e) => setForm({ ...form, skills: e.target.value })}
            rows={3}
            className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="例如：React, TypeScript, Node.js, AWS, 系統設計"
          />
        </div>

        {/* 經歷 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">工作經歷</label>
          <textarea
            value={form.experiences}
            onChange={(e) => setForm({ ...form, experiences: e.target.value })}
            rows={4}
            className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="描述你的主要工作經驗和成就..."
          />
        </div>

        {/* 口頭禪 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            慣用語/口頭禪 <span className="text-gray-400 font-normal">(選填)</span>
          </label>
          <input
            type="text"
            value={form.custom_phrases}
            onChange={(e) => setForm({ ...form, custom_phrases: e.target.value })}
            className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="例如：「這個我有研究過」「以我的經驗來看」"
          />
        </div>

        {/* 其他 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            其他補充 <span className="text-gray-400 font-normal">(選填)</span>
          </label>
          <textarea
            value={form.additional_context}
            onChange={(e) => setForm({ ...form, additional_context: e.target.value })}
            rows={2}
            className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="任何你希望 AI 知道的額外資訊"
          />
        </div>

        <button
          type="submit"
          disabled={upsertMutation.isPending}
          className="px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium text-sm"
        >
          {upsertMutation.isPending ? '儲存中...' : '儲存背景'}
        </button>
      </form>
    </div>
  );
}

// ─── Tab 4: 聲音設定 ────────────────────────────────────

function VoiceTab() {
  return (
    <div className="bg-white rounded-xl shadow-sm border p-6">
      <h3 className="font-bold mb-4">聲音設定</h3>
      <p className="text-sm text-gray-500 mb-6">
        選擇 AI 回覆使用的語音。免費版使用平台預設聲音，付費版可上傳語音樣本客製化。
      </p>

      {/* 預設聲音 */}
      <div className="mb-6">
        <h4 className="text-sm font-medium text-gray-700 mb-3">平台預設聲音</h4>
        <div className="grid grid-cols-2 gap-3">
          <div className="p-4 rounded-xl border-2 border-blue-500 bg-blue-50 cursor-pointer">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-pink-100 flex items-center justify-center">
                <svg className="w-5 h-5 text-pink-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              </div>
              <div>
                <p className="font-medium text-sm">女聲</p>
                <p className="text-xs text-gray-500">自然清晰</p>
              </div>
            </div>
          </div>
          <div className="p-4 rounded-xl border-2 border-gray-200 hover:border-gray-300 cursor-pointer">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              </div>
              <div>
                <p className="font-medium text-sm">男聲</p>
                <p className="text-xs text-gray-500">沉穩低音</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 自訂聲音 */}
      <div className="border-t pt-6">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium text-gray-700">自訂聲音克隆</h4>
          <span className="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full font-medium">
            Pro
          </span>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          上傳 60 秒語音樣本，AI 將模仿你的聲音回答
        </p>
        <div className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center">
          <svg className="w-10 h-10 mx-auto mb-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <p className="text-sm text-gray-500 mb-2">拖曳檔案到此處或點擊上傳</p>
          <p className="text-xs text-gray-400">支援 WAV, MP3, M4A (最長 60 秒)</p>
          <button className="mt-4 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium">
            選擇檔案
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Tab 5: 過渡語 ──────────────────────────────────────

function TransitionTab({ scene }: { scene: Scene }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    transition_enabled: scene.transition_enabled,
    transition_style: scene.transition_style,
  });

  // 取得過渡語列表
  const { data: phrases = [] } = useQuery<Array<{ id: string; phrase: string; style: string }>>({
    queryKey: ['transitions', scene.language, form.transition_style],
    queryFn: () =>
      api
        .get(`/api/v1/transitions?language=${scene.language}&style=${form.transition_style}`)
        .then((r) => r.data || []),
  });

  const updateMutation = useMutation({
    mutationFn: (data: typeof form) => api.put(`/api/v1/scenes/${scene.id}`, data),
    onSuccess: () => {
      toast.success('過渡語設定已更新');
      queryClient.invalidateQueries({ queryKey: ['scenes'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || '更新失敗'),
  });

  return (
    <div className="bg-white rounded-xl shadow-sm border p-6">
      <p className="text-sm text-gray-500 mb-5">
        過渡語是在 AI 思考回答時播放的短語，讓對話更自然
      </p>

      {/* 開關 */}
      <div className="flex items-center justify-between mb-6 pb-6 border-b">
        <div>
          <p className="font-medium text-gray-900">啟用過渡語</p>
          <p className="text-sm text-gray-500">AI 回答前先播放一段自然的過渡短語</p>
        </div>
        <button
          onClick={() => {
            const newVal = !form.transition_enabled;
            setForm({ ...form, transition_enabled: newVal });
            updateMutation.mutate({ ...form, transition_enabled: newVal });
          }}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            form.transition_enabled ? 'bg-blue-600' : 'bg-gray-300'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              form.transition_enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* 風格選擇 */}
      {form.transition_enabled && (
        <>
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">過渡語風格</label>
            <div className="flex gap-3">
              {[
                { value: 'natural', label: '自然口語' },
                { value: 'formal', label: '正式禮貌' },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    setForm({ ...form, transition_style: opt.value });
                  }}
                  className={`px-4 py-2 rounded-lg text-sm font-medium border-2 transition-colors ${
                    form.transition_style === opt.value
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 text-gray-700 hover:border-gray-300'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* 過渡語預覽 */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-3">
              過渡語範例 ({phrases.length} 句)
            </h4>
            {phrases.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {phrases.map((p) => (
                  <span
                    key={p.id}
                    className="px-3 py-1.5 bg-gray-100 text-gray-700 rounded-full text-sm"
                  >
                    &ldquo;{escapeHtml(p.phrase)}&rdquo;
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400">此語言/風格暫無過渡語</p>
            )}
          </div>

          <button
            onClick={() => updateMutation.mutate(form)}
            disabled={updateMutation.isPending}
            className="mt-6 px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium text-sm"
          >
            {updateMutation.isPending ? '儲存中...' : '儲存設定'}
          </button>
        </>
      )}
    </div>
  );
}
