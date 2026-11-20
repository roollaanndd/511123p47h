// Fallback visibility contract for the official Google button (v2.9.21).
//
// renderButton-first removed the One Tap overlay, but a missing client ID (or
// a blocked GIS script) used to leave an empty 44px hole in the login card —
// the user saw no Google login at all. The button must stay visible: when GIS
// cannot mount, show an honest fallback that reports the failure on click.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import GoogleSignInButton from '../../components/shared/GoogleSignInButton';

const mountMock = vi.hoisted(() => vi.fn());

vi.mock('../googleAuth', () => ({
  mountGoogleButton: mountMock,
  googleAuthErrorMessage: (error: unknown) => error instanceof Error ? error.message : 'Gagal login Google.',
}));

beforeEach(() => {
  mountMock.mockReset();
});

describe('GoogleSignInButton', () => {
  it('keeps a visible Google button when GIS cannot mount, and explains on click', async () => {
    const configError = new Error('Google login belum dikonfigurasi. Tambahkan VITE_GOOGLE_CLIENT_ID.');
    mountMock.mockRejectedValue(configError);
    const onError = vi.fn();

    render(<GoogleSignInButton onSuccess={vi.fn()} onError={onError} />);

    const fallback = await screen.findByRole('button', { name: /lanjutkan dengan google/i });
    // Mount failure alone must not paint the form red on first load.
    expect(onError).not.toHaveBeenCalled();

    fireEvent.click(fallback);
    expect(onError).toHaveBeenCalledWith(configError);
  });

  it('does not render a duplicate button when the official button mounts', async () => {
    const dispose = vi.fn();
    mountMock.mockResolvedValue(dispose);

    const { container } = render(<GoogleSignInButton onSuccess={vi.fn()} onError={vi.fn()} />);
    await waitFor(() => expect(mountMock).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole('button', { name: /lanjutkan dengan google/i })).toBeNull();
    expect(container.querySelector('.sp-google-slot')).not.toBeNull();

    // The official slot is still owned by GIS, not by React.
    expect(mountMock.mock.calls[0][0]).toBe(container.querySelector('.sp-google-slot'));
  });
});
