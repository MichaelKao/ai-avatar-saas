'use client';

import { useState, useRef } from 'react';
import { api } from '@/lib/api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { escapeHtml } from '@/lib/utils';
import { toast } from '@/components/Toast';

interface AvatarProfile {
  id: string;
  faceImageUrl: string | null;
  voiceSampleUrl: string | null;
  faceModelStatus: string;
  voiceModelStatus: string;
  createdAt: string;
  updatedAt: string;
}

const statusLabels: Record<string, { text: string; color: string }> = {
  none: { text: '未上傳', color: 'bg-gray-100 text-gray-600' },
  uploaded: { text: '已上傳', color: 'bg-yellow-100 text-yellow-700' },
  processing: { text: '處理中', color: 'bg-blue-100 text-blue-700' },
  ready: { text: '已就緒', color: 'bg-green-100 text-green-700' },
  failed: { text: '處理失敗', color: 'bg-red-100 text-red-700' },
};

export default function AvatarPage() {
  const queryClient = useQueryClient();
  const faceInputRef = useRef<HTMLInputElement>(null);
  const voiceInputRef = useRef<HTMLInputElement>(null);
  const [facePreview, setFacePreview] = useState<string | null>(null);

  const { data: profile, isLoading } = useQuery<AvatarProfile | null>({
    queryKey: ['avatar-profile'],
    queryFn: async () => {
      try {
        const res = await api.get('/api/v1/avatar/profile');
        return res.data || null;
      } catch {
        return null;
      }
    },
  });

  const { data: modelStatus } = useQuery({
    queryKey: ['avatar-model-status'],
    queryFn: () => api.get('/api/v1/avatar/model-status').then((r) => r.data),
    refetchInterval: (query) => {
      const data = query.state.data as { faceModelStatus?: string; voiceModelStatus?: string } | undefined;
      if (
        data?.faceModelStatus === 'processing' ||
        data?.voiceModelStatus === 'processing'
      ) {
        return 5000;
      }
      return false;
    },
  });

  const uploadFaceMutation = useMutation({
    mutationFn: (file: File) => api.upload('/api/v1/avatar/upload-face', file, 'face'),
    onSuccess: () => {
      toast.success('臉部照片上傳成功');
      queryClient.invalidateQueries({ queryKey: ['avatar-profile'] });
      queryClient.invalidateQueries({ queryKey: ['avatar-model-status'] });
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '臉部照片上傳失敗');
    },
  });

  const uploadVoiceMutation = useMutation({
    mutationFn: (file: File) => api.upload('/api/v1/avatar/upload-voice', file, 'voice'),
    onSuccess: () => {
      toast.success('聲音樣本上傳成功');
      queryClient.invalidateQueries({ queryKey: ['avatar-profile'] });
      queryClient.invalidateQueries({ queryKey: ['avatar-model-status'] });
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '聲音樣本上傳失敗');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete('/api/v1/avatar/profile'),
    onSuccess: () => {
      toast.success('Avatar 設定已刪除');
      setFacePreview(null);
      queryClient.invalidateQueries({ queryKey: ['avatar-profile'] });
      queryClient.invalidateQueries({ queryKey: ['avatar-model-status'] });
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '刪除失敗');
    },
  });

  const handleFaceSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 產生預覽
    const reader = new FileReader();
    reader.onload = (ev) => {
      setFacePreview(ev.target?.result as string);
    };
    reader.readAsDataURL(file);

    uploadFaceMutation.mutate(file);
  };

  const handleVoiceSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    uploadVoiceMutation.mutate(file);
  };

  const faceStatus =
    modelStatus?.faceModelStatus || profile?.faceModelStatus || 'none';
  const voiceStatus =
    modelStatus?.voiceModelStatus || profile?.voiceModelStatus || 'none';

  const faceStatusInfo = statusLabels[faceStatus] || statusLabels.none;
  const voiceStatusInfo = statusLabels[voiceStatus] || statusLabels.none;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-8 py-8">
      <h2 className="text-2xl font-bold mb-6">Avatar 設定</h2>

      {/* 臉部照片 */}
      <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold">臉部照片</h3>
          <span
            className={`text-xs px-2 py-0.5 rounded-full font-medium ${faceStatusInfo.color}`}
          >
            {faceStatusInfo.text}
          </span>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          上傳一張正面清晰的照片，AI 會用來生成你的數位分身。
        </p>

        {/* 預覽 */}
        {(facePreview || profile?.faceImageUrl) && (
          <div className="mb-4">
            <img
              src={facePreview || profile?.faceImageUrl || ''}
              alt="臉部照片預覽"
              className="w-32 h-32 rounded-lg object-cover border"
            />
          </div>
        )}

        <input
          ref={faceInputRef}
          type="file"
          accept="image/jpeg,image/png"
          onChange={handleFaceSelect}
          className="hidden"
        />

        <button
          onClick={() => faceInputRef.current?.click()}
          disabled={uploadFaceMutation.isPending}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
        >
          {uploadFaceMutation.isPending ? '上傳中...' : '選擇照片'}
        </button>

        {faceStatus === 'processing' && (
          <p className="mt-3 text-sm text-blue-600 flex items-center gap-2">
            <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600" />
            模型訓練中，請稍候...
          </p>
        )}
      </div>

      {/* 聲音樣本 */}
      <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold">聲音樣本</h3>
          <span
            className={`text-xs px-2 py-0.5 rounded-full font-medium ${voiceStatusInfo.color}`}
          >
            {voiceStatusInfo.text}
          </span>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          上傳一段 10-30 秒的語音，AI 會克隆你的聲音。
        </p>

        {profile?.voiceSampleUrl && (
          <div className="mb-4">
            <audio controls className="w-full">
              <source src={profile.voiceSampleUrl} />
            </audio>
          </div>
        )}

        <input
          ref={voiceInputRef}
          type="file"
          accept="audio/wav,audio/mp3,audio/mpeg"
          onChange={handleVoiceSelect}
          className="hidden"
        />

        <button
          onClick={() => voiceInputRef.current?.click()}
          disabled={uploadVoiceMutation.isPending}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
        >
          {uploadVoiceMutation.isPending ? '上傳中...' : '選擇語音檔'}
        </button>

        {voiceStatus === 'processing' && (
          <p className="mt-3 text-sm text-blue-600 flex items-center gap-2">
            <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600" />
            語音模型訓練中，請稍候...
          </p>
        )}
      </div>

      {/* 刪除 Avatar */}
      {profile && (
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <h3 className="font-bold mb-4 text-red-600">危險區域</h3>
          <p className="text-sm text-gray-600 mb-4">
            刪除 Avatar 設定將清除所有已上傳的臉部照片和聲音樣本。
          </p>
          <button
            onClick={() => {
              if (window.confirm('確定要刪除 Avatar 設定嗎？此操作無法復原。')) {
                deleteMutation.mutate();
              }
            }}
            disabled={deleteMutation.isPending}
            className="px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50 text-sm font-medium"
          >
            {deleteMutation.isPending ? '刪除中...' : '刪除 Avatar 設定'}
          </button>
        </div>
      )}
    </div>
  );
}
