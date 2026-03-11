package tests

import (
	"net/http"
	"testing"
)

func TestHealthEndpoint(t *testing.T) {
	// TODO: 啟動測試伺服器後執行
	t.Skip("需要先啟動伺服器")

	resp, err := http.Get("http://localhost:8080/health")
	if err != nil {
		t.Fatalf("健康檢查失敗: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("預期 200，得到 %d", resp.StatusCode)
	}
}
