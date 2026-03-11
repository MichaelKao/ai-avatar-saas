'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { api } from '@/lib/api';
import { escapeHtml } from '@/lib/utils';

const forgotPasswordSchema = z.object({
  email: z.string().email('請輸入有效的 Email'),
});

type ForgotPasswordForm = z.infer<typeof forgotPasswordSchema>;

export default function ForgotPasswordPage() {
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordForm>({
    resolver: zodResolver(forgotPasswordSchema),
  });

  const onSubmit = async (data: ForgotPasswordForm) => {
    try {
      setError('');
      await api.post('/api/v1/auth/forgot-password', { email: data.email });
      setSuccess(true);
    } catch (err: any) {
      setError(err.response?.data?.error || '操作失敗，請稍後再試');
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md p-8 bg-white rounded-xl shadow-md">
        <h1 className="text-2xl font-bold text-center mb-6">忘記密碼</h1>

        {success ? (
          <div className="space-y-4">
            <div className="p-3 bg-green-50 text-green-600 rounded-lg text-sm">
              如果此 Email 已註冊，重設連結已發送
            </div>
            <p className="text-center text-sm text-gray-600">
              <Link href="/login" className="text-blue-600 hover:underline">
                返回登入
              </Link>
            </p>
          </div>
        ) : (
          <>
            {error && (
              <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm">
                {escapeHtml(error)}
              </div>
            )}

            <p className="mb-4 text-sm text-gray-600">
              輸入你的 Email，我們將寄送密碼重設連結。
            </p>

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  {...register('email')}
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="your@email.com"
                />
                {errors.email && (
                  <p className="mt-1 text-sm text-red-500">
                    {errors.email.message}
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
              >
                {isSubmitting ? '發送中...' : '發送重設連結'}
              </button>
            </form>

            <p className="mt-4 text-center text-sm text-gray-600">
              <Link href="/login" className="text-blue-600 hover:underline">
                返回登入
              </Link>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
