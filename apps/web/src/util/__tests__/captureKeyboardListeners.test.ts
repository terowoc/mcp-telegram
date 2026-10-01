import { expect, test, vi } from 'vitest';

import captureKeyboardListeners from '../captureKeyboardListeners';

test('native modal Escape retains priority when background state registers a later listener', () => {
  const modal = vi.fn();
  const background = vi.fn();
  const releaseModal = captureKeyboardListeners({ onEsc: modal }, true);
  const releaseBackground = captureKeyboardListeners({ onEsc: background });
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(modal).toHaveBeenCalledTimes(1);
    expect(background).not.toHaveBeenCalled();
  } finally {
    releaseBackground();
    releaseModal();
  }
});
