import { supabase } from './db';

/**
 * Google Identity Services, renderButton-first (v2.9.21).
 *
 * We no longer call `prompt()` (One Tap). Its browser/FedCM cooldown made a
 * second click silently do nothing, and the v2.9.11 overlay workaround added
 * a modal on top of the popup. Google's official button rendered in place is
 * user-initiated, always opens the account chooser, and has no cooldown.
 *
 * Supabase still verifies the ID token via `signInWithIdToken`, using the
 * raw nonce that hashes to the SHA-256 nonce handed to GIS initialize.
 */

interface GoogleCredentialResponse {
  credential: string;
}

interface GoogleButtonOptions {
  type?: 'standard' | 'icon';
  theme?: 'outline' | 'filled_blue' | 'filled_black';
  size?: 'large' | 'medium' | 'small';
  shape?: 'rectangular' | 'pill' | 'circle' | 'square';
  text?: 'signin' | 'signup' | 'continue_with' | 'signin_with';
  logo_alignment?: 'left' | 'center';
  locale?: string;
  width?: number;
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
      renderButton?(parent: HTMLElement, options: GoogleButtonOptions): void;
      cancel?(): void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentityApi;
  }
}

export type GoogleSessionData = NonNullable<
  Awaited<ReturnType<typeof supabase.auth.signInWithIdToken>>['data']
>;

export interface GoogleButtonCallbacks {
  /** Fired when a credential arrives and the Supabase exchange starts. */
  onStart?: () => void;
  onSuccess: (data: GoogleSessionData) => void;
  onError: (error: unknown) => void;
}

export interface GoogleButtonAppearance {
  text?: 'signin' | 'signup' | 'continue_with' | 'signin_with';
  width?: number;
  locale?: string;
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

/** Batas waktu pengaman untuk script GIS — jangan biarkan slot kosong selamanya. */
const SCRIPT_WATCHDOG_MS = 12 * 1000;

const GENERIC_START_ERROR = 'Tidak dapat memulai login Google. Silakan coba lagi.';

/**
 * AdminLogin/B2BLogin dulu membuang `error` dan selalu menampilkan pesan
 * generik. Simpan pesan spesifik saat ada, dengan fallback aman untuk throw
 * value bukan Error.
 */
export function googleAuthErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  // The raw error (with the env var name) stays in console.warn for operators;
  // end users only need to know which alternative they can use.
  if (message.includes('VITE_GOOGLE_CLIENT_ID')) {
    return 'Login Google belum tersedia. Silakan masuk dengan email atau hubungi administrator.';
  }
  return message || GENERIC_START_ERROR;
}

/**
 * Pasang tombol Google resmi ke `container`. Mengembalikan fungsi cleanup yang
 * mengosongkan slot dan mengabaikan credential yang terlambat (React unmount).
 */
export async function mountGoogleButton(
  container: HTMLElement,
  callbacks: GoogleButtonCallbacks,
  appearance: GoogleButtonAppearance = {},
): Promise<() => void> {
  const clientId = String(import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim();
  if (!clientId) throw new Error('Google login belum dikonfigurasi. Tambahkan VITE_GOOGLE_CLIENT_ID.');

  const google = await Promise.race([
    loadGoogleIdentityServices(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Google Identity Services tidak merespons. Coba lagi atau gunakan email.')), SCRIPT_WATCHDOG_MS),
    ),
  ]);

  if (typeof google.accounts.id.renderButton !== 'function') {
    throw new Error('Google login tidak dapat dibuka di peramban ini. Coba login dengan email dan kata sandi.');
  }

  const nonce = createNonce();
  const hashedNonce = await nonce.hashedPromise;
  let destroyed = false;

  google.accounts.id.initialize({
    client_id: clientId,
    nonce: hashedNonce,
    use_fedcm_for_prompt: true,
    callback: async (response) => {
      if (destroyed) return;
      callbacks.onStart?.();
      try {
        const result = await supabase.auth.signInWithIdToken({
          provider: 'google',
          token: response.credential,
          nonce: nonce.raw,
        });
        if (destroyed) return;
        if (result.error) throw result.error;
        callbacks.onSuccess(result.data);
      } catch (error) {
        if (!destroyed) callbacks.onError(error);
      }
    },
  });

  const measuredWidth = container.clientWidth || 0;
  google.accounts.id.renderButton(container, {
    type: 'standard',
    theme: 'outline',
    size: 'large',
    shape: 'pill',
    text: appearance.text ?? 'continue_with',
    logo_alignment: 'left',
    locale: appearance.locale ?? 'id',
    width: appearance.width ?? Math.max(200, Math.min(measuredWidth || 320, 420)),
  });

  return () => {
    destroyed = true;
    container.innerHTML = '';
  };
}
