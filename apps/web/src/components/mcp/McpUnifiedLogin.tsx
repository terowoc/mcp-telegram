import { memo, useEffect, useRef, useState } from '../../lib/teact/teact';

import type { UnifiedLoginState } from './types';

import { subscribeMcpCancellation } from '../../util/mcpLogin';
import { createStyledQrCode } from '../../util/qrCode/buildStyledQrCode';
import { UnifiedLoginController } from './unifiedLogin';

import useAsync from '../../hooks/useAsync';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';

import styles from './McpPanel.module.scss';

type OwnProps = {
  isOpen?: boolean;
  shouldStart?: boolean;
  browserTelegramId?: string;
  continuation?: string;
  hasPassword?: boolean;
  shouldResume?: boolean;
  shouldReauthenticate?: boolean;
  onSuccess: () => Promise<void>;
};
const ACTIVE_STATES = new Set(['connecting', 'token', 'needs-password', 'verified', 'completing']);
const QR_SIZE = 256;

function McpUnifiedLogin({ isOpen, shouldStart, browserTelegramId, continuation, hasPassword,
  shouldResume, shouldReauthenticate, onSuccess }: OwnProps) {
  const lang = useLang();
  const [state, setState] = useState<UnifiedLoginState>({ isBusy: false, isManual: false });
  const [password, setPassword] = useState('');
  const controllerRef = useRef<UnifiedLoginController>();
  const hasStartedRef = useRef(false);
  const hasResumedRef = useRef(false);
  const handleSuccess = useLastCallback(onSuccess);
  if (!controllerRef.current) {
    controllerRef.current = new UnifiedLoginController({ onChange: setState, onSuccess: handleSuccess });
  }
  const controller = controllerRef.current;
  useEffect(() => {
    controller.setBrowserAccount(browserTelegramId);
    setPassword('');
  }, [controller, browserTelegramId]);
  useEffect(() => {
    if (isOpen && browserTelegramId && (shouldStart || shouldReauthenticate) && !hasStartedRef.current) {
      hasStartedRef.current = true;
      void controller.start({ continuation, shouldLinkLegacy: hasPassword });
    }
    if (!shouldReauthenticate && !shouldStart) hasStartedRef.current = false;
  }, [controller, isOpen, browserTelegramId, shouldStart, shouldReauthenticate, continuation, hasPassword]);
  useEffect(() => {
    if (isOpen && shouldResume && continuation && !hasResumedRef.current) {
      hasResumedRef.current = true;
      void controller.resume(continuation);
    }
  }, [controller, isOpen, shouldResume, continuation]);
  useEffect(() => {
    if (!isOpen) {
      setPassword('');
      void controller.cancel();
    }
    return () => {
      void controller.cancel();
    };
  }, [controller, isOpen]);
  useEffect(() => subscribeMcpCancellation(() => controller.revokeContext()), [controller]);
  useEffect(() => {
    setPassword('');
  }, [state.attempt?.id, state.attempt?.state]);
  const manualToken = state.isManual && state.attempt?.state === 'token' ? state.attempt.token : undefined;
  const { result: qrDataUrl } = useAsync(async () => {
    if (!manualToken) return undefined;
    const code = await createStyledQrCode({ size: QR_SIZE });
    code.update({ data: `tg://login?token=${manualToken}` });
    const blob = await code.getRawData('png');
    if (!(blob instanceof Blob)) return undefined;
    return new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.readAsDataURL(blob);
    });
  }, [manualToken]);
  const handlePassword = useLastCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = password;
    setPassword('');
    if (state.attempt?.state === 'verified') await controller.complete({ legacyPassword: value });
    else await controller.submitPassword(value);
  });
  const attempt = state.attempt;
  const isActive = Boolean(attempt && ACTIVE_STATES.has(attempt.state));
  const needsPassword = attempt?.state === 'needs-password'
    || (attempt?.state === 'verified' && state.requiresLegacy);
  const errorKey = state.error?.status === 503 || state.error?.status === 429 ? 'McpCapacity'
    : state.error?.code === 'legacy-link-required' ? 'McpLegacyLinkRequired'
      : state.error?.code === 'continuation-expired' ? 'McpContinuationExpired' : 'McpBridgeFailed';

  return (
    <section className={styles.unified}>
      <h2 className={styles.heading}>{lang('McpUnifiedTitle')}</h2>
      <p className={styles.note}>{lang('McpPersistentAccess')}</p>
      {shouldReauthenticate && <p className={styles.warning}>{lang('McpReauthenticate')}</p>}
      {!isActive && attempt?.state !== 'success' && (
        <Button
          disabled={state.isBusy || !browserTelegramId}
          onClick={() => controller.start({ continuation, shouldLinkLegacy: hasPassword })}
        >
          {lang('McpConnectCurrent')}
        </Button>
      )}
      {state.error && (
        <p className={styles.warning} role="alert">
          {lang(errorKey)}
          {state.error.retryAfter ? ` ${lang('McpRetrySeconds', { seconds: state.error.retryAfter })}` : ''}
        </p>
      )}
      {attempt?.state === 'success' && <p className={styles.note} role="status">{lang('McpLoginSuccess')}</p>}
      {(attempt?.state === 'expired' || attempt?.state === 'cancelled' || attempt?.state === 'error') && (
        <p className={styles.note} role="status">
          {lang(attempt.state === 'expired' ? 'McpExpired' : 'McpLoginFailed')}
        </p>
      )}
      {isActive && !needsPassword && <p className={styles.note} role="status">{lang('McpBridgeWaiting')}</p>}
      {manualToken && qrDataUrl && (
        <div className={styles.qrBox}>
          <img className={styles.qr} src={qrDataUrl} alt={lang('McpQrAlt')} />
          <p className={styles.note}>{lang('McpQrInstructions')}</p>
        </div>
      )}
      {needsPassword && (
        <form className={styles.form} onSubmit={handlePassword}>
          <label className={styles.label} htmlFor="mcp-unified-password">
            {lang(attempt?.state === 'verified' ? 'McpPassword' : 'McpTwoFactor')}
          </label>
          <input
            className="form-control"
            id="mcp-unified-password"
            type="password"
            value={password}
            maxLength={1024}
            autoComplete="off"
            required
            onInput={(event: React.FormEvent<HTMLInputElement>) => setPassword(event.currentTarget.value)}
          />
          <p className={styles.note}>
            {lang(attempt?.state === 'verified' ? 'McpLegacyPasswordNote' : 'McpTwoFactorNote')}
          </p>
          <Button type="submit" disabled={state.isBusy || !password}>{lang('McpSubmitPassword')}</Button>
        </form>
      )}
      {isActive && (
        <Button
          color="translucent"
          onClick={() => {
            setPassword('');
            void controller.cancel();
          }}
        >
          {lang('McpCancel')}
        </Button>
      )}
      {attempt?.state !== 'success' && (
        <Button
          size="tiny"
          color="translucent"
          disabled={state.isBusy}
          onClick={() => controller.start({ continuation, isManual: true, shouldLinkLegacy: hasPassword })}
        >
          {lang('McpManualQr')}
        </Button>
      )}
    </section>
  );
}

export default memo(McpUnifiedLogin);
