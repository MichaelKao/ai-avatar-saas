'use client';

import { useState, Suspense } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { escapeHtml } from '@/lib/utils';

const resetPasswordSchema = z
  .object({
    new_password: z.string().min(8, '密碼至少 8 個字元'),
    confirm_password: z.string().min(8, '密碼至少 8 個字元'),
  })
  .refine((data) => data.new_password === data.confirm_password, {
    message: '密碼不一致',
    path: ['confirm_password'],
  });

type ResetPasswordForm = z.infer<typeof resetPasswordSchema>;

function ResetPasswordContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [error, setError] = useState('');

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordForm>({
    resolver: zodResolver(resetPasswordSchema),
  });

  const onSubmit = async (data: ResetPasswordForm) => {
    if (!token) {
      setError('缺少重設密碼的 token，請重新點擊信件中的連結');
      return;
    }

    try {
      setError('');
      await api.post('/api/v1/auth/reset-password', {
        token,
        new_password: data.new_password,
      });
      router.push('/login');
    } catch (err: any) {
      setError(err.response?.data?.error || '重設密碼失敗');
    }
  };

  if (!token) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-full max-w-md p-8 bg-white rounded-xl shadow-md">
          <h1 className="text-2xl font-bold text-center mb-6">重設密碼</h1>
          <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm">
            無效的重設連結，請重新申請密碼重設。
          </div>
          <p className="text-center text-sm text-gray-600">
            <Link href="/forgot-password" className="text-blue-600 hover:underline">
              重新申請
            </Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md p-8 bg-white rounded-xl shadow-md">
        <h1 className="text-2xl font-bold text-center mb-6">重設密碼</h1>

        {error && (
          <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm">
            {escapeHtml(error)}
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              新密碼
            </label>
            <input
              type="password"
              {...register('new_password')}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="至少 8 個字元"
            />
            {errors.new_password && (
              <p className="mt-1 text-sm text-red-500">
                {errors.new_password.message}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              確認新密碼
            </label>
            <input
              type="password"
              {...register('confirm_password')}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="再次輸入新密碼"
            />
            {errors.confirm_password && (
              <p className="mt-1 text-sm text-red-500">
                {errors.confirm_password.message}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
          >
            {isSubmitting ? '重設中...' : '重設密碼'}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-gray-600">
          <Link href="/login" className="text-blue-600 hover:underline">
            返回登入
          </Link>
        </p>
      </div>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-full max-w-md p-8 bg-white rounded-xl shadow-md text-center">
          載入中...
        </div>
      </main>
    }>
      <ResetPasswordContent />
    </Suspense>
  );
}
