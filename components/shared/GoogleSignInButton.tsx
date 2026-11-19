import React, { useEffect, useRef } from 'react';
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

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;

    let dispose: (() => void) | undefined;
    let cancelled = false;

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
      if (!cancelled) callbacksRef.current.onError(error);
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [text]);

  return (
    <div
      ref={slotRef}
      className={`sp-google-slot flex min-h-[44px] w-full items-center justify-center ${className}`}
      aria-label="Lanjutkan dengan Google"
    />
  );
};

export { googleAuthErrorMessage };
export default GoogleSignInButton;
