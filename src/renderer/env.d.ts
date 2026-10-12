import type { OverlayApi } from '../preload/overlay';
import type { AppApi } from '../preload/app';

declare global {
  interface Window {
    quillOverlay?: OverlayApi;
    quill?: AppApi;
  }
}
export {};
