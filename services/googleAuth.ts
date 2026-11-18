import { supabase } from './db';

interface GoogleCredentialResponse {
  credential: string;
}

/**
 * GIS prompt notification. The newer API exposes detailed getters
 * (getNotDisplayedReason / getSkippedReason / getDismissedReason); older
 * clients only expose the boolean shorthands.
 */
interface GooglePromptNotification {
  isNotDisplayed(): boolean;
  isSkippedMoment(): boolean;
  getNotDisplayedReason?(): string;
  getSkippedReason?(): string;
  getDismissedReason?(): string;
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
      prompt(callback?: (notification: GooglePromptNotification) => void): void;
      cancel(): void;
      renderButton?(parent: HTMLElement, options: GoogleButtonOptions): void;
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

/** Alasan mentah dari notifikasi prompt GIS (fallback ke shorthand boolean lama). */
function promptFailureReason(notification: GooglePromptNotification | undefined): string {
  if (!notification) return 'unknown';
  // Getters bisa mengembalikan undefined ATAU '' pada klien lama — perlakukan
  // keduanya sebagai "tidak ada info".
  const detail =
    [notification.getSkippedReason?.(), notification.getNotDisplayedReason?.(), notification.getDismissedReason?.()]
      .find((value) => value) ?? '';
  if (detail) return detail;
  if (notification.isSkippedMoment()) return 'skipped';
  if (notification.isNotDisplayed()) return 'not_displayed';
  return 'unknown';
}

// ── Fallback overlay: tombol Google resmi ────────────────────────────────────
//
// Popup One Tap punya cooldown peramban/FedCM: begitu pengguna menutup
// popupnya, panggilan prompt() berikutnya di-skip diam-diam selama beberapa
// lama (skipped moment) — klik "Lanjut dengan Google" lagi terlihat mati.
// Alur tombol resmi (renderButton) TIDAK kena cooldown itu: klik pengguna
// selalu membuka pemilih akun. Jadi saat prompt di-skip/tak tampil, kami
// menampilkan tombol Google resmi dalam overlay agar setiap klik berikutnya
// punya jalan yang benar-benar berfungsi (searah dengan fallback renderButton
// yang dirancang di PR #386).

const FALLBACK_OVERLAY_ID = 'sp-gsi-fallback';

function buildFallbackOverlay(
  reason: string,
  onDismiss: () => void,
): { buttonSlot: HTMLDivElement; requestDismiss: () => void } {
  let dismissed = false;
  const root = document.createElement('div');
  root.id = FALLBACK_OVERLAY_ID;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Lanjutkan dengan Google');
  root.style.cssText =
    'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:1rem;background:rgba(2,6,23,0.55);font-family:Sora,system-ui,sans-serif;';

  const card = document.createElement('div');
  card.style.cssText =
    'background:#fff;border-radius:1.25rem;padding:1.75rem 1.5rem;max-width:22rem;width:100%;text-align:center;box-shadow:0 24px 60px -24px rgba(6,95,70,0.45);display:flex;flex-direction:column;gap:0.75rem;align-items:center;';

  const title = document.createElement('p');
  title.textContent = 'Lanjutkan dengan Google';
  title.style.cssText = 'font-weight:800;color:#0f172a;font-size:1.05rem;margin:0;';

  const body = document.createElement('p');
  body.style.cssText = 'color:#64748b;font-size:0.8rem;line-height:1.5;margin:0;';
  body.textContent =
    reason === 'user_cancel'
      ? 'Popup Google ditutup sebelum selesai. Klik tombol di bawah untuk mencoba lagi.'
      : 'Popup One Tap tidak dapat ditampilkan sekarang (mis. jeda peramban setelah popup ditutup). Klik tombol Google di bawah untuk melanjutkan.';

  const buttonSlot = document.createElement('div');
  buttonSlot.dataset.gsiFallbackButton = 'true';
  buttonSlot.style.cssText = 'min-height:2.75rem;display:flex;align-items:center;justify-content:center;';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Batal';
  cancel.style.cssText =
    'background:none;border:none;color:#64748b;font-size:0.75rem;font-weight:600;cursor:pointer;letter-spacing:0.08em;text-transform:uppercase;padding:0.25rem 0.5rem;';

  const requestDismiss = () => {
    if (dismissed) return;
    dismissed = true;
    document.removeEventListener('keydown', onEscape);
    root.remove();
    onDismiss();
  };
  const onEscape = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') requestDismiss();
  };

  root.addEventListener('click', (ev) => {
    if (ev.target === root) requestDismiss();
  });
  document.addEventListener('keydown', onEscape);
  cancel.addEventListener('click', () => requestDismiss());

  card.append(title, body, buttonSlot, cancel);
  root.append(card);
  document.body.append(root);

  return { buttonSlot, requestDismiss };
}

/** Batas waktu pengaman: klik login tidak boleh memantul tanpa jawaban. */
const PROMPT_WATCHDOG_MS = 5 * 60 * 1000;

export async function signInWithGoogleIdToken(): Promise<NonNullable<Awaited<ReturnType<typeof supabase.auth.signInWithIdToken>>['data']>> {
  const clientId = String(import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim();
  if (!clientId) throw new Error('Google login belum dikonfigurasi. Tambahkan VITE_GOOGLE_CLIENT_ID.');

  const google = await loadGoogleIdentityServices();
  const nonce = createNonce();
  const hashedNonce = await nonce.hashedPromise;

  return new Promise((resolve, reject) => {
    let settled = false;
    let overlayDismiss: (() => void) | null = null;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      // Tutup overlay fallback (jika ada) — no-op saat tidak ada.
      overlayDismiss?.();
      overlayDismiss = null;
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
          settle(() => resolve(result.data));
        } catch (error) {
          settle(() => reject(error));
        }
      },
    });

    // Watchdog: kalau GIS tidak pernah memanggil callback/notification,
    // jangan biarkan tombol login berputar selamanya.
    const watchdog = setTimeout(() => {
      settle(() => reject(new Error('Login Google tidak merespons. Coba lagi atau gunakan email dan kata sandi.')));
    }, PROMPT_WATCHDOG_MS);

    google.accounts.id.prompt((notification) => {
      const reason = promptFailureReason(notification);
      if (reason === 'unknown') {
        // Prompt tampil normal — tunggu credential dari callback initialize.
        return;
      }

      if (reason === 'user_cancel') {
        // Pengguna menutup popup yang tampil. Jangan auto-tampilkan modal
        // (barusan mereka menolak) — cukup berhenti dengan pesan yang jujur.
        settle(() => reject(new Error('Login Google dibatalkan. Klik tombol Google untuk mencoba lagi.')));
        return;
      }

      // Prompt di-skip/tak tampil (cooldown setelah popup ditutup, cookie
      // pihak ketiga diblokir, dsb). Jangan salahkan pemblokir popup secara
      // membabi buta — tampilkan tombol Google resmi sebagai jalan yang pasti.
      if (typeof google.accounts.id.renderButton !== 'function') {
        settle(() => reject(new Error('Google login tidak dapat dibuka di peramban ini. Coba login dengan email dan kata sandi.')));
        return;
      }

      const overlay = buildFallbackOverlay(reason, () => {
        // Pengguna menutup overlay fallback (Esc / backdrop / Batal).
        settle(() => reject(new Error('Login Google dibatalkan. Klik tombol Google untuk mencoba lagi.')));
      });
      overlayDismiss = overlay.requestDismiss;
      google.accounts.id.renderButton(overlay.buttonSlot, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        shape: 'pill',
        text: 'continue_with',
        logo_alignment: 'left',
        locale: 'id',
      });
      // Tombol resmi yang diklik pengguna memicu callback initialize di atas —
      // sesi diselesaikan lewat sana (overlay ditutup oleh settle).
    });
  });
}
