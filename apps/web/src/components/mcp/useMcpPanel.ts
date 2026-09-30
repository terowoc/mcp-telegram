import { useEffect, useRef, useState } from '../../lib/teact/teact';

import type { McpPanelState } from './types';

import { McpPanelController } from './state';

export default function useMcpPanel({
  isOpen,
  browserTelegramId,
}: {
  isOpen?: boolean;
  browserTelegramId?: string;
}) {
  const [state, setState] = useState<McpPanelState>({
    clients: [],
    isBusy: false,
    isSignedOut: true,
    hasMismatch: false,
  });
  const controllerRef = useRef<McpPanelController>();
  if (!controllerRef.current) controllerRef.current = new McpPanelController({ onChange: setState });
  const controller = controllerRef.current;

  useEffect(() => {
    if (isOpen) void controller.show();
    else controller.hide();
    return () => controller.hide();
  }, [controller, isOpen]);

  useEffect(() => {
    controller.setBrowserAccount(browserTelegramId);
  }, [controller, browserTelegramId]);

  useEffect(() => {
    function updateVisibility() {
      controller.setVisible(!document.hidden);
    }
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, [controller]);

  return { ...state, actions: controller };
}
