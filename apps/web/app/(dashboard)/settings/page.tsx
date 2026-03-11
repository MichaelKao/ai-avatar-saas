'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuthStore } from '@/lib/stores/auth';
import { api } from '@/lib/api';
import { useMutation } from '@tanstack/react-query';
import { escapeHtml } from '@/lib/utils';
import { toast } from '@/components/Toast';
import { useRouter } from 'next/navigation';

// 修改密碼表單
const changePasswordSchema = z
  .object({
    current_password: z.string().min(1, '請輸入目前密碼'),
    new_password: z.string().min(8, '新密碼至少 8 個字元'),
    confirm_password: z.string().min(8, '密碼至少 8 個字元'),
  })
  .refine((data) => data.new_password === data.confirm_password, {
    message: '密碼不一致',
    path: ['confirm_password'],
  });

type ChangePasswordForm = z.infer<typeof changePasswordSchema>;

// 修改個人資訊表單
const profileSchema = z.object({
  name: z.string().min(1, '請輸入姓名'),
});

type ProfileForm = z.infer<typeof profileSchema>;

export default function SettingsPage() {
  const router = useRouter();
  const { user } = useAuthStore();

  // 修改密碼表單
  const {
    register: registerPassword,
    handleSubmit: handleSubmitPassword,
    formState: { errors: passwordErrors },
    reset: resetPasswordForm,
  } = useForm<ChangePasswordForm>({
    resolver: zodResolver(changePasswordSchema),
  });

  // 修改個人資訊表單
  const {
    register: registerProfile,
    handleSubmit: handleSubmitProfile,
    formState: { errors: profileErrors },
  } = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      name: user?.name || '',
    },
  });

  // 修改密碼 mutation
  const changePasswordMutation = useMutation({
    mutationFn: (data: { current_password: string; new_password: string }) =>
      api.put('/api/v1/auth/change-password', data),
    onSuccess: () => {
      toast.success('密碼修改成功');
      resetPasswordForm();
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '修改密碼失敗');
    },
  });

  // 修改個人資訊 mutation
  const updateProfileMutation = useMutation({
    mutationFn: (data: { name: string }) =>
      api.put('/api/v1/auth/profile', data),
    onSuccess: (res: any) => {
      toast.success('個人資訊已更新');
      // 更新 store 中的 user
      if (res.data?.user) {
        useAuthStore.getState().setUser(res.data.user);
      } else if (user) {
        useAuthStore.getState().setUser({
          ...user,
          name: res.data?.name || user.name,
        });
      }
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '更新個人資訊失敗');
    },
  });

  // 刪除帳號 mutation
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

  const onSubmitPassword = (data: ChangePasswordForm) => {
    changePasswordMutation.mutate({
      current_password: data.current_password,
      new_password: data.new_password,
    });
  };

  const onSubmitProfile = (data: ProfileForm) => {
    updateProfileMutation.mutate({ name: data.name });
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-8 py-8">
      <h2 className="text-2xl font-bold mb-6">帳號設定</h2>

      {/* 個人資訊（顯示） */}
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

      {/* 修改個人資訊 */}
      <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
        <h3 className="font-bold mb-4">修改個人資訊</h3>
        <form
          onSubmit={handleSubmitProfile(onSubmitProfile)}
          className="space-y-4"
        >
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              姓名
            </label>
            <input
              type="text"
              {...registerProfile('name')}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="你的名字"
            />
            {profileErrors.name && (
              <p className="mt-1 text-sm text-red-500">
                {profileErrors.name.message}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={updateProfileMutation.isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
          >
            {updateProfileMutation.isPending ? '儲存中...' : '儲存'}
          </button>
        </form>
      </div>

      {/* 修改密碼 */}
      <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
        <h3 className="font-bold mb-4">修改密碼</h3>
        <form
          onSubmit={handleSubmitPassword(onSubmitPassword)}
          className="space-y-4"
        >
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              目前密碼
            </label>
            <input
              type="password"
              {...registerPassword('current_password')}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="輸入目前密碼"
            />
            {passwordErrors.current_password && (
              <p className="mt-1 text-sm text-red-500">
                {passwordErrors.current_password.message}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              新密碼
            </label>
            <input
              type="password"
              {...registerPassword('new_password')}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="至少 8 個字元"
            />
            {passwordErrors.new_password && (
              <p className="mt-1 text-sm text-red-500">
                {passwordErrors.new_password.message}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              確認新密碼
            </label>
            <input
              type="password"
              {...registerPassword('confirm_password')}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="再次輸入新密碼"
            />
            {passwordErrors.confirm_password && (
              <p className="mt-1 text-sm text-red-500">
                {passwordErrors.confirm_password.message}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={changePasswordMutation.isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
          >
            {changePasswordMutation.isPending ? '修改中...' : '修改密碼'}
          </button>
        </form>
      </div>

      {/* 危險區域 */}
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
