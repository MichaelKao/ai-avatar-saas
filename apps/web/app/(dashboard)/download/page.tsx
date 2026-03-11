'use client';

const DOWNLOAD_URL =
  'https://github.com/MichaelKao/ai-avatar-saas/releases/latest/download/AI.Avatar.Desktop_0.3.0_x64-setup.exe';

export default function DownloadPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-8 py-8">
      {/* 標題 */}
      <h2 className="text-2xl font-bold mb-2">下載桌面版 App</h2>
      <p className="text-gray-500 mb-8">
        桌面版 App 讓 AI 分身能擷取系統音訊並透過虛擬麥克風、虛擬攝影機將語音與畫面送進視訊軟體，實現完整的 AI
        代開會體驗。若您只需要 Mode 1（提詞模式），可直接使用網頁版；Mode 2 / Mode 3 則必須安裝桌面版。
      </p>

      {/* 下載區塊 */}
      <div className="bg-white rounded-xl shadow-sm border p-6 mb-8">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <div className="w-14 h-14 rounded-xl bg-blue-100 flex items-center justify-center flex-shrink-0">
            <svg className="w-7 h-7 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3"
              />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-bold mb-1">AI Avatar Desktop</h3>
            <p className="text-sm text-gray-500">Windows 安裝包 (.exe)</p>
          </div>
          <a
            href={DOWNLOAD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-medium shadow-lg transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3"
              />
            </svg>
            下載安裝檔
          </a>
        </div>

        {/* 系統需求 */}
        <div className="mt-4 pt-4 border-t border-gray-100">
          <p className="text-xs text-gray-400 font-medium mb-1">系統需求</p>
          <p className="text-sm text-gray-600">Windows 10 / 11（64-bit）</p>
        </div>
      </div>

      {/* 安裝步驟 */}
      <div className="bg-white rounded-xl shadow-sm border p-6 mb-8">
        <h3 className="text-lg font-bold mb-4">安裝與設定步驟</h3>
        <ol className="space-y-4">
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-blue-100 text-blue-700 text-sm font-bold flex items-center justify-center">
              1
            </span>
            <div>
              <p className="font-medium text-gray-900">下載安裝包</p>
              <p className="text-sm text-gray-500">點擊上方按鈕下載 .exe 安裝檔。</p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-blue-100 text-blue-700 text-sm font-bold flex items-center justify-center">
              2
            </span>
            <div>
              <p className="font-medium text-gray-900">雙擊執行安裝</p>
              <p className="text-sm text-gray-500">按照安裝精靈指示完成安裝。</p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-blue-100 text-blue-700 text-sm font-bold flex items-center justify-center">
              3
            </span>
            <div>
              <p className="font-medium text-gray-900">安裝 VB-Cable 虛擬麥克風</p>
              <p className="text-sm text-gray-500">
                下載並安裝免費的虛擬音訊裝置，讓 AI 語音可被視訊軟體辨識為麥克風輸入。
              </p>
              <a
                href="https://vb-audio.com/Cable/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 mt-1"
              >
                前往 VB-Cable 官網
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                  />
                </svg>
              </a>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-blue-100 text-blue-700 text-sm font-bold flex items-center justify-center">
              4
            </span>
            <div>
              <p className="font-medium text-gray-900">安裝 OBS Virtual Camera</p>
              <p className="text-sm text-gray-500">
                安裝 OBS Studio 以取得虛擬攝影機功能，讓 AI 生成的臉部畫面可被視訊軟體辨識為攝影機。
              </p>
              <a
                href="https://obsproject.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 mt-1"
              >
                前往 OBS 官網
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                  />
                </svg>
              </a>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-blue-100 text-blue-700 text-sm font-bold flex items-center justify-center">
              5
            </span>
            <div>
              <p className="font-medium text-gray-900">打開 AI Avatar Desktop，用帳密登入</p>
              <p className="text-sm text-gray-500">使用與網頁版相同的帳號密碼登入桌面版。</p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-blue-100 text-blue-700 text-sm font-bold flex items-center justify-center">
              6
            </span>
            <div>
              <p className="font-medium text-gray-900">
                在視訊軟體設定麥克風為「CABLE Output」、攝影機為「OBS Virtual Camera」
              </p>
              <p className="text-sm text-gray-500">
                打開 Zoom / Google Meet / Teams 的音訊與攝影機設定，將輸入裝置切換至虛擬裝置。
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-blue-100 text-blue-700 text-sm font-bold flex items-center justify-center">
              7
            </span>
            <div>
              <p className="font-medium text-gray-900">點擊「啟動分身」，開始使用</p>
              <p className="text-sm text-gray-500">一切就緒！AI 分身將自動幫你回答會議對話。</p>
            </div>
          </li>
        </ol>
      </div>

      {/* 模式比較表 */}
      <div className="bg-white rounded-xl shadow-sm border p-6 mb-8">
        <h3 className="text-lg font-bold mb-4">模式比較</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-3 pr-4 font-medium text-gray-500">功能</th>
                <th className="text-center py-3 px-4 font-medium text-gray-500">Mode 1</th>
                <th className="text-center py-3 px-4 font-medium text-gray-500">Mode 2</th>
                <th className="text-center py-3 px-4 font-medium text-gray-500">Mode 3</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              <tr>
                <td className="py-3 pr-4 text-gray-700">名稱</td>
                <td className="py-3 px-4 text-center text-gray-700">Prompt 提詞</td>
                <td className="py-3 px-4 text-center text-gray-700">語音分身</td>
                <td className="py-3 px-4 text-center text-gray-700">完整分身</td>
              </tr>
              <tr>
                <td className="py-3 pr-4 text-gray-700">AI 提供建議文字</td>
                <td className="py-3 px-4 text-center text-green-600 font-bold">&#10003;</td>
                <td className="py-3 px-4 text-center text-green-600 font-bold">&#10003;</td>
                <td className="py-3 px-4 text-center text-green-600 font-bold">&#10003;</td>
              </tr>
              <tr>
                <td className="py-3 pr-4 text-gray-700">AI 語音自動回答</td>
                <td className="py-3 px-4 text-center text-gray-300">&mdash;</td>
                <td className="py-3 px-4 text-center text-green-600 font-bold">&#10003;</td>
                <td className="py-3 px-4 text-center text-green-600 font-bold">&#10003;</td>
              </tr>
              <tr>
                <td className="py-3 pr-4 text-gray-700">AI 臉部替換</td>
                <td className="py-3 px-4 text-center text-gray-300">&mdash;</td>
                <td className="py-3 px-4 text-center text-gray-300">&mdash;</td>
                <td className="py-3 px-4 text-center text-green-600 font-bold">&#10003;</td>
              </tr>
              <tr>
                <td className="py-3 pr-4 text-gray-700">需要桌面版 App</td>
                <td className="py-3 px-4 text-center text-gray-300">&mdash;</td>
                <td className="py-3 px-4 text-center text-amber-600 font-bold">需要</td>
                <td className="py-3 px-4 text-center text-amber-600 font-bold">需要</td>
              </tr>
              <tr>
                <td className="py-3 pr-4 text-gray-700">可在網頁版使用</td>
                <td className="py-3 px-4 text-center text-green-600 font-bold">&#10003;</td>
                <td className="py-3 px-4 text-center text-gray-300">&mdash;</td>
                <td className="py-3 px-4 text-center text-gray-300">&mdash;</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-3">
          <p className="text-sm text-amber-800">
            <span className="font-medium">提示：</span>Mode 1 可直接在網頁版使用，無需安裝任何軟體。Mode 2 和 Mode 3
            需要桌面版 App 才能正常運作，因為這些模式需要擷取系統音訊及使用虛擬裝置。
          </p>
        </div>
      </div>

      {/* FAQ */}
      <div className="bg-white rounded-xl shadow-sm border p-6">
        <h3 className="text-lg font-bold mb-4">常見問題</h3>
        <div className="space-y-4">
          <div>
            <h4 className="font-medium text-gray-900 mb-1">Q: 為什麼需要桌面版？</h4>
            <p className="text-sm text-gray-600">
              A: Mode 2 / Mode 3
              需要擷取系統音訊和使用虛擬裝置（虛擬麥克風、虛擬攝影機），這些功能瀏覽器無法實現，必須透過桌面應用程式才能做到。
            </p>
          </div>
          <div className="border-t border-gray-100 pt-4">
            <h4 className="font-medium text-gray-900 mb-1">Q: 支援 Mac 嗎？</h4>
            <p className="text-sm text-gray-600">A: 目前僅支援 Windows 10 / 11（64-bit），Mac 版本正在開發中。</p>
          </div>
          <div className="border-t border-gray-100 pt-4">
            <h4 className="font-medium text-gray-900 mb-1">Q: VB-Cable 是什麼？</h4>
            <p className="text-sm text-gray-600">
              A: VB-Cable 是一款免費的虛擬音訊裝置，安裝後會在系統中新增一組虛擬的麥克風與喇叭。AI
              生成的語音會輸出到這個虛擬喇叭，而視訊軟體則從對應的虛擬麥克風（CABLE Output）讀取音訊，讓對方聽到 AI
              的聲音。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
