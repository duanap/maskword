import { registerSW } from "virtual:pwa-register";

declare global {
  interface Window {
    maskwordApplyUpdate?: () => Promise<void>;
  }
}

export function registerMaskwordPwa() {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      window.maskwordApplyUpdate = () => updateSW(true);
      window.dispatchEvent(new Event("maskword:pwa-update"));
    },
    onOfflineReady() {
      window.dispatchEvent(new Event("maskword:pwa-offline-ready"));
    },
  });
}
