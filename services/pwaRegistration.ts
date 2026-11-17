import { registerSW } from 'virtual:pwa-register';

let registered = false;

/** Register the shared PWA worker for every HTML entry point. */
export function registerPwaServiceWorker() {
  if (registered || typeof window === 'undefined') return;
  registered = true;

  try {
    registerSW({
      immediate: true,
      onRegisteredSW(_swUrl, registration) {
        if (!registration) return;

        const checkForUpdate = () => {
          if (document.visibilityState !== 'visible') return;
          void registration.update().catch(() => {
            // Offline update checks must never interrupt app use.
          });
        };

        checkForUpdate();
        document.addEventListener('visibilitychange', checkForUpdate);
        window.addEventListener('pageshow', checkForUpdate);
      },
    });
  } catch (error) {
    // PWA support is progressive; the app remains usable if registration fails.
    console.warn('SW registration failed (non-blocking):', error);
  }
}
