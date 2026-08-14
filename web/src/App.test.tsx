import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderApp } from './test/renderApp';
import { useAppStore } from './store/useAppStore';

beforeEach(() => {
  useAppStore.getState().reset();
  // The API is not running in unit tests; every route must survive that.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('app shell', () => {
  it('renders the brand and all three navigation destinations', () => {
    renderApp();

    expect(screen.getAllByText('SplatScene').length).toBeGreaterThan(0);
    for (const label of ['Projects', 'Capture', 'Viewer']) {
      expect(screen.getAllByRole('link', { name: label }).length).toBeGreaterThan(0);
    }
  });

  it('shows the projects page at /', async () => {
    renderApp('/');

    expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    // The unreachable API must degrade into a retryable message, not a crash.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument(),
    );
  });

  it('shows the capture page with a camera input and a photo counter', () => {
    renderApp('/capture');

    const cameraInput = screen.getByTestId('camera-input');
    expect(cameraInput).toHaveAttribute('type', 'file');
    expect(cameraInput).toHaveAttribute('accept', 'image/*');
    expect(cameraInput).toHaveAttribute('capture', 'environment');
    expect(cameraInput).toHaveAttribute('multiple');
    expect(screen.getByTestId('photo-count')).toHaveTextContent('0');
    expect(screen.getByText(/photos selected/i)).toBeInTheDocument();
  });

  it('shows the viewer placeholder and its URL field at /viewer', () => {
    renderApp('/viewer');

    expect(screen.getByLabelText('Splat URL')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /no scene loaded/i })).toBeInTheDocument();
    // Nothing to load yet, so the renderer chunk must stay unmounted.
    expect(screen.queryByTestId('splat-canvas')).not.toBeInTheDocument();
  });

  it('redirects unknown routes to the projects list', () => {
    renderApp('/does-not-exist');

    expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
  });
});
