// apps/store/src/types/window.d.ts
export {};

declare global {
  interface Window {
    /** 一部ブラウザで提供されるバーコード検出API */
    BarcodeDetector?: any;
  }
}
