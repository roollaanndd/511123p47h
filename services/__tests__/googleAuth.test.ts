// Contract tests for the renderButton-first Google sign-in (v2.9.21).
//
// The old flow called GIS One Tap `prompt()` first and only rendered the
// official button inside an overlay after the prompt was skipped. That made
// the second click look dead (browser/FedCM cooldown) and added an extra modal.
// The new flow renders Google's official button in place, from the first paint.
// No prompt(), no overlay, no cooldown — and the raw nonce ↔ SHA-256 pairing
// verified by Supabase stays exactly the same. These tests pin that contract.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { googleAuthErrorMessage, mountGoogleButton } from '../googleAuth';

const signInWithIdTokenMock = vi.hoisted(() => vi.fn());

vi.mock('../db', () => ({
  supabase: { auth: { signInWithIdToken: signInWithIdTokenMock } },
}));

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

type CredentialCallback = (response: { credential: string }) => void;
type InitializeOptions = {
  client_id: string;
  nonce: string;
  callback: CredentialCallback;
  use_fedcm_for_prompt?: boolean;
};

function installFakeGoogle({ withRenderButton = true }: { withRenderButton?: boolean } = {}) {
  const initialize = vi.fn();
  const prompt = vi.fn();
  const renderButton = vi.fn();
  const id: Record<string, unknown> = { initialize, prompt };
  if (withRenderButton) id.renderButton = renderButton;
  (window as unknown as { google: unknown }).google = { accounts: { id } };
  return { initialize, prompt, renderButton };
}

function mountButton(options: { text?: 'continue_with' | 'signin_with' } = {}) {
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  const onSuccess = vi.fn();
  const onError = vi.fn();
  const onStart = vi.fn();
  const pending = mountGoogleButton(slot, { onSuccess, onError, onStart }, options);
  return { slot, onSuccess, onError, onStart, pending };
}

beforeEach(() => {
  // jsdom's crypto polyfill in vitest.setup.ts has no subtle.digest, which
  // createNonce() needs — pin the real WebCrypto implementation instead.
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
  document.body.innerHTML = '';
});

const captureRejection = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
    throw new Error('expected the promise to reject');
  } catch (error) {
    return error as Error;
  }
};

describe('mountGoogleButton', () => {
  it('rejects with a configuration message when VITE_GOOGLE_CLIENT_ID is missing', async () => {
    (import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_CLIENT_ID = '';
    installFakeGoogle();

    const error = await captureRejection(mountButton().pending);
    expect(error.message).toMatch(/VITE_GOOGLE_CLIENT_ID/);
  });

  it('renders the official Google button in place on the first mount — never One Tap', async () => {
    const g = installFakeGoogle();

    const { slot, pending } = mountButton();
    await expect(pending).resolves.toBeTypeOf('function');

    expect(g.renderButton).toHaveBeenCalledTimes(1);
    expect(g.prompt).not.toHaveBeenCalled();

    const [parent, options] = g.renderButton.mock.calls[0];
    expect(parent).toBe(slot);
    expect(options).toMatchObject({
      type: 'standard',
      theme: 'outline',
      size: 'large',
      shape: 'pill',
      text: 'continue_with',
      logo_alignment: 'left',
      locale: 'id',
    });
    expect(options.width).toBeGreaterThanOrEqual(200);
  });

  it('exchanges the credential with the raw nonce that matches the hashed init nonce', async () => {
    const g = installFakeGoogle();
    const { onSuccess, onError, onStart, pending } = mountButton();
    await pending;

    const init = g.initialize.mock.calls[0][0] as InitializeOptions;
    expect(init.client_id).toBe(CLIENT_ID);
    expect(init.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(init.callback).toBeTypeOf('function');

    const session = { user: { id: 'user-1' }, session: { access_token: 'at' } };
    signInWithIdTokenMock.mockResolvedValue({ data: session, error: null });
    init.callback({ credential: 'test-credential' });

    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith(session));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    const call = signInWithIdTokenMock.mock.calls[0][0];
    expect(call).toMatchObject({ provider: 'google', token: 'test-credential' });
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(call.nonce));
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(hex).toBe(init.nonce);
  });

  it('reports a Supabase failure through onError and never calls onSuccess', async () => {
    const g = installFakeGoogle();
    const { onSuccess, onError, pending } = mountButton();
    await pending;

    signInWithIdTokenMock.mockResolvedValue({ data: null, error: new Error('Token ditolak') });
    (g.initialize.mock.calls[0][0] as InitializeOptions).callback({ credential: 'bad' });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect((onError.mock.calls[0][0] as Error).message).toBe('Token ditolak');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('cleans up the slot and ignores a credential delivered after unmount', async () => {
    const g = installFakeGoogle();
    const { slot, onSuccess, onError, pending } = mountButton();
    const dispose = await pending;
    slot.innerHTML = '<span>button</span>';

    dispose();
    expect(slot.innerHTML).toBe('');

    signInWithIdTokenMock.mockResolvedValue({
      data: { user: { id: 'late' }, session: null }, error: null,
    });
    (g.initialize.mock.calls[0][0] as InitializeOptions).callback({ credential: 'late' });
    await Promise.resolve();

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects with an honest browser message when renderButton is unavailable', async () => {
    installFakeGoogle({ withRenderButton: false });

    const error = await captureRejection(mountButton().pending);
    expect(error.message).toMatch(/peramban ini/i);
  });

  it('honours a custom button text for registration surfaces', async () => {
    const g = installFakeGoogle();

    await mountButton({ text: 'signin_with' }).pending;
    expect(g.renderButton.mock.calls[0][1]).toMatchObject({ text: 'signin_with' });
  });
});

describe('googleAuthErrorMessage', () => {
  it('preserves the specific failure reported by Google/Supabase', () => {
    expect(googleAuthErrorMessage(new Error('Login Google dibatalkan. Klik tombol Google untuk mencoba lagi.')))
      .toBe('Login Google dibatalkan. Klik tombol Google untuk mencoba lagi.');
  });

  it('hides env-var jargon from users while keeping the specific failure', () => {
    expect(googleAuthErrorMessage(new Error('Google login belum dikonfigurasi. Tambahkan VITE_GOOGLE_CLIENT_ID.')))
      .toBe('Login Google belum tersedia. Silakan masuk dengan email atau hubungi administrator.');
  });

  it('falls back to the generic message for non-Error throw values', () => {
    expect(googleAuthErrorMessage(undefined))
      .toBe('Tidak dapat memulai login Google. Silakan coba lagi.');
  });
});
