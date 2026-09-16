// Vitest 全域測試設定(每個測試檔案執行前都會先跑這裡)。
// 只負責掛上 @testing-library/jest-dom 的額外 matcher(例如 toBeInTheDocument),
// 不放任何測試邏輯本身。
import "@testing-library/jest-dom/vitest";
