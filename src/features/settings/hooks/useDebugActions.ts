import { useCallback } from 'react';
import { backend } from '../../../services/backendAdapter';

export interface DebugActions {
  disableBackendDebug: () => Promise<void>;
}

export const useDebugActions = (): DebugActions => {
  const disableBackendDebug = useCallback(async () => {
    if (backend.isAvailable) {
      try {
        const secret = sessionStorage.getItem('github-stars-manager-backend-secret');
        await fetch('/api/logs/debug', {
          method: 'POST',
          // 用 X-GSM-Secret 而非 Authorization：后端托管在魔搭时该标准头被平台覆盖。
          headers: {
            'Content-Type': 'application/json',
            ...(secret ? { 'X-GSM-Secret': secret } : {}),
          },
          body: JSON.stringify({ enabled: false }),
        });
      } catch { /* Backend unreachable — same silent behavior as the component */ }
    }
  }, []);
  return { disableBackendDebug };
};
