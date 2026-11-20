import React, { useEffect, useRef, useState } from 'react';
import {
  googleAuthErrorMessage,
  mountGoogleButton,
  type GoogleSessionData,
} from '../../services/googleAuth';

interface GoogleSignInButtonProps {
  onSuccess: (data: GoogleSessionData) => void;
  onError: (error: unknown) => void;
  onStart?: () => void;
  text?: 'continue_with' | 'signin_with' | 'signup' | 'signin';
  className?: string;
}

/**
 * Mounts Google's official renderButton directly into the login card.
 * No One Tap prompt and no fallback overlay: the button is the first action
 * the user sees, so every click opens the account chooser.
 *
 * If GIS cannot mount (missing VITE_GOOGLE_CLIENT_ID, blocked script), the slot
 * must not become an empty hole. Show an honest fallback that reports the
 * reason when clicked — the user can then choose email/password deliberately.
 */
const GoogleSignInButton: React.FC<GoogleSignInButtonProps> = ({
  onSuccess,
  onError,
  onStart,
  text = 'continue_with',
  className = '',
}) => {
  const slotRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef({ onSuccess, onError, onStart });
  callbacksRef.current = { onSuccess, onError, onStart };
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;

    let dispose: (() => void) | undefined;
    let cancelled = false;
    setFailure(null);

    mountGoogleButton(
      slot,
      {
        onSuccess: (data) => { if (!cancelled) callbacksRef.current.onSuccess(data); },
        onError: (error) => { if (!cancelled) callbacksRef.current.onError(error); },
        onStart: () => { if (!cancelled) callbacksRef.current.onStart?.(); },
      },
      { text },
    ).then((cleanup) => {
      if (cancelled) cleanup();
      else dispose = cleanup;
    }).catch((error) => {
      if (cancelled) return;
      console.warn('Tombol Google tidak dapat dipasang', error);
      // Do not call onError here: a config problem should not paint the form
      // red on first paint. The fallback explains itself when clicked.
      setFailure(error);
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [text]);

  const fallbackLabel = text === 'signup'
    ? 'Daftar dengan Google'
    : text === 'signin'
      ? 'Masuk dengan Google'
      : 'Lanjutkan dengan Google';

  return (
    <div className={`w-full ${className}`}>
      <div
        ref={slotRef}
        className={`sp-google-slot flex min-h-[44px] w-full items-center justify-center ${failure ? 'hidden' : ''}`}
        aria-label="Lanjutkan dengan Google"
      />
      {failure !== null && (
        <button
          type="button"
          onClick={() => callbacksRef.current.onError(failure)}
          className="sp-google-slot flex min-h-[44px] w-full items-center justify-center gap-3 rounded-full border border-slate-200 bg-white px-4 text-[0.7rem] font-bold text-slate-700 shadow-sm transition hover:border-emerald-500/40 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        >
          <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full font-bold" style={{ color: '#4285F4', fontFamily: 'Arial, sans-serif' }}>G</span>
          {fallbackLabel}
        </button>
      )}
    </div>
  );
};

export { googleAuthErrorMessage };
export default GoogleSignInButton;
