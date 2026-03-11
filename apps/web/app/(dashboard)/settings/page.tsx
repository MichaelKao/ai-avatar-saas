'use client';

import { useAuthStore } from '@/lib/stores/auth';
import { api } from '@/lib/api';
import { useMutation } from '@tanstack/react-query';
import { escapeHtml } from '@/lib/utils';
import { toast } from '@/components/Toast';
import { useRouter } from 'next/navigation';

export default function SettingsPage() {
  const router = useRouter();
  const { user } = useAuthStore();

  const deleteAccountMutation = useMutation({
    mutationFn: () => api.delete('/api/v1/auth/account'),
    onSuccess: () => {
      toast.success('帳號已刪除');
      useAuthStore.getState().logout();
      router.push('/login');
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '刪除帳號失敗');
    },
  });

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-8 py-8">
      <h2 className="text-2xl font-bold mb-6">帳號設定</h2>

      <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
        <h3 className="font-bold mb-4">個人資訊</h3>
        <div className="space-y-3">
          <div>
            <span className="text-sm text-gray-500">Email:</span>
            <span className="ml-2">
              {user?.email ? escapeHtml(user.email) : ''}
            </span>
          </div>
          <div>
            <span className="text-sm text-gray-500">姓名:</span>
            <span className="ml-2">
              {user?.name ? escapeHtml(user.name) : '未設定'}
            </span>
          </div>
          <div>
            <span className="text-sm text-gray-500">方案:</span>
            <span className="ml-2">
              {escapeHtml(user?.plan || 'free')}
            </span>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border p-6">
        <h3 className="font-bold mb-4 text-red-600">危險區域</h3>
        <p className="text-sm text-gray-600 mb-4">
          刪除帳號後所有資料將永久消失，此操作無法復原。
        </p>
        <button
          onClick={() => {
            if (
              window.confirm(
                '確定要刪除帳號嗎？此操作無法復原，所有資料將被永久刪除。'
              )
            ) {
              deleteAccountMutation.mutate();
            }
          }}
          disabled={deleteAccountMutation.isPending}
          className="px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50 text-sm font-medium"
        >
          {deleteAccountMutation.isPending ? '刪除中...' : '刪除帳號'}
        </button>
      </div>
    </div>
  );
}
