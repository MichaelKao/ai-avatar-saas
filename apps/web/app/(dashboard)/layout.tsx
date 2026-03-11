'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/stores/auth';
import DashboardLayout from '@/components/Layout';
import ToastContainer from '@/components/Toast';

export default function DashboardGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const token = useAuthStore((s) => s.token);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!token) {
      router.push('/login');
    } else {
      setChecked(true);
    }
  }, [token, router]);

  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <>
      <DashboardLayout>{children}</DashboardLayout>
      <ToastContainer />
    </>
  );
}
