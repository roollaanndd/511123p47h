// Contract tests for the Google sign-in fallback (v2.9.11).
//
// Owner report: the One Tap popup closes fine, but clicking "Masuk dengan
// Google" again shows nothing. GIS enforces a browser-side prompt cooldown
// after a dismissal (skipped moment), so the second prompt() is silently
// skipped — the old code then blamed "popup blocked", which was both wrong
// and unfixable for the user. The fix: on any skip/not-displayed reason
// (except a fresh user_cancel), render Google's OFFICIAL button in an overlay
// — renderButton clicks are user-initiated and never cooldown-blocked.
// These tests pin that contract so the two login entry points
// (AuthGate + AdminLogin) can't silently regress.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { googleAuthErrorMessage, signInWithGoogleIdToken } from '../googleAuth';

const signInWithIdTokenMock = vi.hoisted(() => vi.fn());

vi.mock('../db', () => ({
  supabase: { auth: { signInWithIdToken: signInWithIdTokenMock } },
}));

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

interface FakeNotification {
  skippedReason?: string;
  notDisplayedReason?: string;
  dismissedReason?: string;
}

/** Mirrors the real GIS prompt notification (new getters + legacy booleans). */
const fakeNotification = ({
  skippedReason,
  notDisplayedReason,
  dismissedReason,
}: FakeNotification) => ({
  isNotDisplayed: () => Boolean(notDisplayedReason),
  isSkippedMoment: () => Boolean(skippedReason),
  getNotDisplayedReason: () => notDisplayedReason ?? '',
  getSkippedReason: () => skippedReason ?? '',
  getDismissedReason: () => dismissedReason ?? '',
});

type PromptCallback = (notification: ReturnType<typeof fakeNotification>) => void;
type InitializeOptions = {
  client_id: string;
  nonce: string;
  callback: (response: { credential: string }) => void;
};

function installFakeGoogle(behavior: { onPrompt?: (cb: PromptCallback) => void } = {}) {
  const initialize = vi.fn();
  const prompt = vi.fn((cb?: PromptCallback) => {
    behavior.onPrompt?.(cb!);
  });
  const renderButton = vi.fn();
  (window as unknown as { google: unknown }).google = {
    accounts: { id: { initialize, prompt, renderButton } },
  };
  return { initialize, prompt, renderButton };
}

const overlay = () => document.getElementById('sp-gsi-fallback');
const overlayButtonSlot = () => document.querySelector<HTMLDivElement>('#sp-gsi-fallback [data-gsi-fallback-button]');

beforeEach(() => {
  // Pin crypto to Node's webcrypto: jsdom's polyfill in vitest.setup.ts lacks
  // subtle.digest, which createNonce() needs.
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: {
      getRandomValues: (arr: Uint8Array) => webcrypto.getRandomValues(arr),
      subtle: webcrypto.subtle,
    },
  });
  (import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_CLIENT_ID = CLIENT_ID;
  signInWithIdTokenMock.mockReset();
});

afterEach(() => {
  delete (window as unknown as { google?: unknown }).google;
  overlay()?.remove();
});

const captureRejection = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
    throw new Error('expected the promise to reject');
  } catch (error) {
    return error as Error;
  }
};

describe('signInWithGoogleIdToken', () => {
  it('rejects with a configuration message when VITE_GOOGLE_CLIENT_ID is missing', async () => {
    (import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_CLIENT_ID = '';
    installFakeGoogle();

    const error = await captureRejection(signInWithGoogleIdToken());
    expect(error.message).toMatch(/VITE_GOOGLE_CLIENT_ID/);
  });

  it('shows the official Google button in an overlay when the prompt is skipped (cooldown)', async () => {
    // "auto_cancel" is what GIS reports after the browser enforces its
    // post-dismissal cooldown — exactly the owner's second-click scenario.
    const { initialize, prompt, renderButton } = installFakeGoogle({
      onPrompt: (cb) => cb(fakeNotification({ skippedReason: 'auto_cancel' })),
    });

    const pending = signInWithGoogleIdToken();
    await vi.waitFor(() => expect(overlay()).toBeTruthy());
    expect(prompt).toHaveBeenCalled();

    // The overlay is a real dialog containing the official button slot...
    expect(overlay()!.getAttribute('role')).toBe('dialog');
    expect(overlayButtonSlot()).toBeTruthy();
    // ...rendered through renderButton with the official button options.
    expect(renderButton).toHaveBeenCalledTimes(1);
    const [slot, options] = renderButton.mock.calls[0];
    expect(slot).toBe(overlayButtonSlot());
    expect(options).toMatchObject({
      type: 'standard',
      theme: 'outline',
      shape: 'pill',
      text: 'continue_with',
      logo_alignment: 'left',
      locale: 'id',
    });

    // The initialize callback must carry the SHA-256 of the nonce that later
    // goes to Supabase (Supabase verifies exactly that pairing).
    const initOptions = initialize.mock.calls[0][0] as InitializeOptions;
    expect(initOptions.client_id).toBe(CLIENT_ID);
    expect(initOptions.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(initOptions.callback).toBeTypeOf('function');

    // Clicking the official button delivers a credential through the SAME
    // initialize callback → signInWithIdToken with the raw nonce.
    signInWithIdTokenMock.mockResolvedValue({
      data: { user: { id: 'user-1' }, session: { access_token: 'at' } },
      error: null,
    });
    initOptions.callback({ credential: 'test-credential' });

    await expect(pending).resolves.toEqual({ user: { id: 'user-1' }, session: { access_token: 'at' } });

    const call = signInWithIdTokenMock.mock.calls[0][0];
    expect(call).toMatchObject({ provider: 'google', token: 'test-credential' });
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(call.nonce));
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(hex).toBe(initOptions.nonce);

    // Success closes the overlay.
    expect(overlay()).toBeNull();
  });

  it('closes the fallback overlay and rejects honestly when the user presses Escape', async () => {
    installFakeGoogle({
      onPrompt: (cb) => cb(fakeNotification({ skippedReason: 'auto_cancel' })),
    });

    const pending = signInWithGoogleIdToken();
    await vi.waitFor(() => expect(overlay()).toBeTruthy());

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    const error = await captureRejection(pending);
    expect(error.message).toMatch(/dibatalkan/i);
    expect(overlay()).toBeNull();
  });

  it('rejects after a real user_cancel without showing any overlay', async () => {
    // The popup WAS displayed and the user closed it — showing another modal
    // immediately would be obnoxious. Honest message, no overlay.
    const { renderButton } = installFakeGoogle({
      onPrompt: (cb) => cb(fakeNotification({ dismissedReason: 'user_cancel' })),
    });

    const error = await captureRejection(signInWithGoogleIdToken());
    expect(error.message).toMatch(/dibatalkan/i);
    expect(overlay()).toBeNull();
    expect(renderButton).not.toHaveBeenCalled();
  });

  it('waits for the credential when the prompt is displayed normally (no overlay)', async () => {
    const { initialize, prompt, renderButton } = installFakeGoogle({
      onPrompt: (cb) => cb(fakeNotification({})),
    });

    signInWithIdTokenMock.mockResolvedValue({
      data: { user: { id: 'user-2' }, session: null },
      error: null,
    });

    const pending = signInWithGoogleIdToken();
    await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
    expect(overlay()).toBeNull();
    expect(renderButton).not.toHaveBeenCalled();

    const initOptions = initialize.mock.calls[0][0] as InitializeOptions;
    initOptions.callback({ credential: 'normal-credential' });

    await expect(pending).resolves.toEqual({ user: { id: 'user-2' }, session: null });
    expect(signInWithIdTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google', token: 'normal-credential' }),
    );
  });

  it('rejects with an honest message when the prompt is skipped and renderButton is unavailable', async () => {
    const g = installFakeGoogle({
      onPrompt: (cb) => cb(fakeNotification({ skippedReason: 'unknown_reason' })),
    });
    // Simulate an older GIS client without renderButton (mutate the object
    // actually stored on window, not the returned mock aggregate).
    (window as unknown as { google: { accounts: { id: Record<string, unknown> } } }).google.accounts.id =
      { initialize: g.initialize, prompt: g.prompt };

    const error = await captureRejection(signInWithGoogleIdToken());
    expect(error.message).toMatch(/peramban ini/i);
    expect(overlay()).toBeNull();
  });
});

describe('googleAuthErrorMessage', () => {
  it('preserves the specific failure reported by Google/Supabase', () => {
    expect(googleAuthErrorMessage(new Error('Login Google dibatalkan. Klik tombol Google untuk mencoba lagi.')))
      .toBe('Login Google dibatalkan. Klik tombol Google untuk mencoba lagi.');
  });

  it('falls back to the generic message for non-Error throw values', () => {
    expect(googleAuthErrorMessage(undefined))
      .toBe('Tidak dapat memulai login Google. Silakan coba lagi.');
  });
});
