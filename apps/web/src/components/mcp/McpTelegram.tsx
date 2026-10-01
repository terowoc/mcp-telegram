import { memo, useEffect, useState } from '../../lib/teact/teact';

import type { McpPanelController } from './state';
import type { LoginAttempt, SaasMe } from './types';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';
import ConfirmDialog from '../ui/ConfirmDialog';

import styles from './McpPanel.module.scss';

type OwnProps = {
  me: SaasMe;
  attempt?: LoginAttempt;
  isBusy: boolean;
  browserTelegramId?: string;
  hasMismatch: boolean;
  actions: McpPanelController;
};
const ACTIVE_STATES = new Set(['connecting', 'qr', 'needs-password']);

function McpTelegram({ me, attempt, isBusy, browserTelegramId, hasMismatch, actions }: OwnProps) {
  const lang = useLang();
  const [password, setPassword] = useState('');
  const [isDisconnectOpen, setIsDisconnectOpen] = useState(false);
  useEffect(() => {
    setPassword('');
  }, [attempt?.id, attempt?.state]);
  const isActive = Boolean(attempt && ACTIVE_STATES.has(attempt.state));
  const handlePassword = useLastCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = password;
    setPassword('');
    await actions.submitPassword(value);
  });
  const account = me.telegram.account || attempt?.account;

  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>{lang('McpTelegram')}</h2>
      <div className={styles.identityGrid}>
        <div className={styles.card}>
          <span className={styles.note}>{lang('McpBrowserAccount')}</span>
          <strong className={styles.identity}>{browserTelegramId || lang('McpNotConnected')}</strong>
        </div>
        <div className={styles.card}>
          <span className={styles.note}>{lang('McpServerAccount')}</span>
          <strong className={styles.identity}>
            {account
              ? `@${account.username || account.id}`
              : lang(me.telegram.sessionPresent ? 'McpUnknownIdentity' : 'McpNotConnected')}
          </strong>
          <span className={styles.note}>
            {me.telegram.sessionPresent ? lang('McpSessionSaved') : lang('McpNotConnected')}
          </span>
        </div>
      </div>
      {hasMismatch && (
        <p className={styles.warning} role="alert">
          {lang('McpMismatch')}
        </p>
      )}
      <p className={styles.note}>{lang('McpSeparateSessions')}</p>
      {!isActive && (
        <Button disabled={isBusy} onClick={() => actions.startLogin()}>
          {lang('McpManualQr')}
        </Button>
      )}
      {attempt?.state === 'qr' && attempt.dataUrl && (
        <div className={styles.qrBox}>
          <img className={styles.qr} src={attempt.dataUrl} alt={lang('McpQrAlt')} />
          <p className={styles.note}>{lang('McpQrInstructions')}</p>
        </div>
      )}
      {attempt?.state === 'connecting' && (
        <p className={styles.note} role="status">
          {lang('McpWaiting')}
        </p>
      )}
      {attempt?.state === 'needs-password' && (
        <form className={styles.form} onSubmit={handlePassword}>
          <label className={styles.label} htmlFor="mcp-cloud-password">
            {lang('McpTwoFactor')}
          </label>
          <input
            className="form-control"
            id="mcp-cloud-password"
            type="password"
            value={password}
            maxLength={1024}
            autoComplete="off"
            required
            onInput={(event: React.FormEvent<HTMLInputElement>) => setPassword(event.currentTarget.value)}
          />
          <p className={styles.note}>{lang('McpTwoFactorNote')}</p>
          <Button type="submit" disabled={isBusy || !password}>
            {lang('McpSubmitPassword')}
          </Button>
        </form>
      )}
      {isActive && (
        <Button
          color="translucent"
          disabled={isBusy}
          onClick={() => {
            setPassword('');
            void actions.cancelLogin();
          }}
        >
          {lang('McpCancel')}
        </Button>
      )}
      {attempt && !isActive && (
        <p className={styles.note} role="status">
          {lang(
            attempt.state === 'success'
              ? 'McpLoginSuccess'
              : attempt.state === 'expired'
                ? 'McpExpired'
                : attempt.state === 'cancelled'
                  ? 'McpCancelled'
                  : 'McpLoginFailed',
          )}
        </p>
      )}
      {me.telegram.sessionPresent && (
        <Button color="danger" disabled={isBusy} onClick={() => setIsDisconnectOpen(true)}>
          {lang('McpDisconnect')}
        </Button>
      )}
      <ConfirmDialog
        isOpen={isDisconnectOpen}
        title={lang('McpDisconnect')}
        text={lang('McpDisconnectConfirm')}
        confirmLabel={lang('McpConfirm')}
        onClose={() => setIsDisconnectOpen(false)}
        confirmHandler={() => {
          setIsDisconnectOpen(false);
          void actions.disconnect();
        }}
      />
    </section>
  );
}

export default memo(McpTelegram);
