import Link from 'next/link';

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      {/* 導航列 */}
      <nav className="flex items-center justify-between px-8 py-4 max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold text-blue-600">AI Avatar</h1>
        <div className="flex gap-4">
          <Link
            href="/login"
            className="px-4 py-2 text-blue-600 hover:text-blue-800 font-medium"
          >
            登入
          </Link>
          <Link
            href="/register"
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
          >
            免費試用
          </Link>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="max-w-7xl mx-auto px-8 py-24 text-center">
        <h2 className="text-5xl font-bold text-gray-900 mb-6">
          AI 數位分身
          <br />
          <span className="text-blue-600">替你參加會議</span>
        </h2>
        <p className="text-xl text-gray-600 mb-8 max-w-2xl mx-auto">
          在 Zoom、Teams、Google Meet 中使用 AI 數位分身，
          自動聆聽對話、生成回覆、克隆你的聲音與臉部表情。
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/register"
            className="inline-block px-8 py-4 bg-blue-600 text-white text-lg rounded-xl hover:bg-blue-700 font-medium shadow-lg"
          >
            開始使用 — 免費
          </Link>
          <a
            href="https://github.com/MichaelKao/ai-avatar-saas/releases/download/v0.8.1/AI.Avatar.Desktop_0.8.1_x64-setup.exe"
            className="inline-flex items-center gap-2 px-8 py-4 bg-gray-900 text-white text-lg rounded-xl hover:bg-gray-800 font-medium shadow-lg"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3" />
            </svg>
            下載桌面版 App
          </a>
        </div>
      </section>

      {/* 三種模式 */}
      <section className="max-w-7xl mx-auto px-8 py-16">
        <h3 className="text-3xl font-bold text-center mb-12">三種服務模式</h3>
        <div className="grid md:grid-cols-3 gap-8">
          <div className="p-6 bg-white rounded-xl shadow-md border">
            <div className="text-4xl mb-4">💡</div>
            <h4 className="text-xl font-bold mb-2">提示模式</h4>
            <p className="text-gray-600">
              AI 在畫面角落顯示建議答案，你自己決定是否採用
            </p>
          </div>
          <div className="p-6 bg-white rounded-xl shadow-md border border-blue-200">
            <div className="text-4xl mb-4">🎭</div>
            <h4 className="text-xl font-bold mb-2">替身模式</h4>
            <p className="text-gray-600">
              AI 即時取代你的臉部與聲音，完全自動回答
            </p>
          </div>
          <div className="p-6 bg-white rounded-xl shadow-md border border-purple-200">
            <div className="text-4xl mb-4">✨</div>
            <h4 className="text-xl font-bold mb-2">全能模式</h4>
            <p className="text-gray-600">
              換裝、換背景、切換 AI 模型、調整個性
            </p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="text-center py-8 text-gray-500">
        <p>&copy; 2026 AI Avatar SaaS. All rights reserved.</p>
      </footer>
    </main>
  );
}
