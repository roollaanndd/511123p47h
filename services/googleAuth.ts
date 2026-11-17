import { supabase } from './db';

interface GoogleCredentialResponse {
  credential: string;
}

interface GoogleIdentityApi {
  accounts: {
    id: {
      initialize(options: {
        client_id: string;
        callback: (response: GoogleCredentialResponse) => void;
        nonce?: string;
        auto_select?: boolean;
        use_fedcm_for_prompt?: boolean;
      }): void;
      prompt(callback?: (notification: { isNotDisplayed(): boolean; isSkippedMoment(): boolean }) => void): void;
      cancel(): void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentityApi;
  }
}

let googleScriptPromise: Promise<GoogleIdentityApi> | null = null;

function loadGoogleIdentityServices(): Promise<GoogleIdentityApi> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google);
  if (googleScriptPromise) return googleScriptPromise;

  googleScriptPromise = new Promise<GoogleIdentityApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-surepath-google-identity]');
    if (existing) {
      existing.addEventListener('load', () => window.google ? resolve(window.google) : reject(new Error('Google Identity Services unavailable')));
      existing.addEventListener('error', () => reject(new Error('Google Identity Services failed to load')));
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.dataset.surepathGoogleIdentity = 'true';
    script.onload = () => window.google ? resolve(window.google) : reject(new Error('Google Identity Services unavailable'));
    script.onerror = () => reject(new Error('Google Identity Services failed to load'));
    document.head.appendChild(script);
  });

  return googleScriptPromise;
}

function createNonce(): { raw: string; hashedPromise: Promise<string> } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = btoa(String.fromCharCode(...bytes));
  const hashedPromise = crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)).then((hash) =>
    Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  );
  return { raw, hashedPromise };
}

export async function signInWithGoogleIdToken(): Promise<NonNullable<Awaited<ReturnType<typeof supabase.auth.signInWithIdToken>>['data']>> {
  const clientId = String(import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim();
  if (!clientId) throw new Error('Google login belum dikonfigurasi. Tambahkan VITE_GOOGLE_CLIENT_ID.');

  const google = await loadGoogleIdentityServices();
  const nonce = createNonce();
  const hashedNonce = await nonce.hashedPromise;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };

    google.accounts.id.initialize({
      client_id: clientId,
      nonce: hashedNonce,
      use_fedcm_for_prompt: true,
      callback: async (response) => {
        try {
          const result = await supabase.auth.signInWithIdToken({
            provider: 'google',
            token: response.credential,
            nonce: nonce.raw,
          });
          if (result.error) throw result.error;
          finish(() => resolve(result.data));
        } catch (error) {
          finish(() => reject(error));
        }
      },
    });

    google.accounts.id.prompt((notification) => {
      if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
        finish(() => reject(new Error('Google login tidak dapat dibuka. Pastikan popup tidak diblokir.')));
      }
    });
  });
}
