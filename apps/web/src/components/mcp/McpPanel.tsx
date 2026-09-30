import { memo, useEffect, useState } from '../../lib/teact/teact';

import useMcpPanel from './useMcpPanel';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';
import ConfirmDialog from '../ui/ConfirmDialog';
import Modal from '../ui/Modal';
import McpAccess from './McpAccess';
import McpAuth from './McpAuth';
import McpClients from './McpClients';
import McpConnectionHelp from './McpConnectionHelp';
import McpTelegram from './McpTelegram';

import styles from './McpPanel.module.scss';

export type OwnProps = { isOpen?: boolean; browserTelegramId?: string; onClose: NoneToVoidFunction };
const SECTIONS = [
  { id: 'telegram', label: 'McpTelegram' },
  { id: 'access', label: 'McpAccess' },
  { id: 'clients', label: 'McpClients' },
  { id: 'connect', label: 'McpConnect' },
  { id: 'account', label: 'McpAccount' },
] as const;

function McpPanel({ isOpen, browserTelegramId, onClose }: OwnProps) {
  const lang = useLang();
  const state = useMcpPanel({ isOpen, browserTelegramId });
  const [section, setSection] = useState<(typeof SECTIONS)[number]['id']>('telegram');
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [password, setPassword] = useState('');
  const { me, actions, isBusy, error } = state;
  useEffect(() => {
    setPassword('');
    setIsDeleteOpen(false);
  }, [me?.user.id, isOpen]);
  const handleClose = useLastCallback(() => {
    // Native confirmations receive Escape before the underlying panel closes
    if (document.querySelector('dialog.confirm[open]')) return;
    setPassword('');
    setIsDeleteOpen(false);
    actions.hide();
    onClose();
  });
  const errorKey =
    error?.status === 503 || error?.status === 429
      ? 'McpCapacity'
      : error?.status === 400 || error?.status === 401
        ? 'McpAuthFailed'
        : 'McpRequestFailed';

  return (
    <Modal
      isOpen={isOpen}
      isNativeDialog
      onClose={handleClose}
      hasCloseButton
      isBackButton
      title={lang('McpTitle')}
      dialogClassName={styles.dialog}
      contentClassName={styles.content}
      noFreezeOnClose
    >
      {isOpen && (
        <>
          {error && (
            <div className={styles.error} role="alert">
              <p className={styles.note}>{lang(errorKey)}</p>
              {Boolean(error.retryAfter) && (
                <p className={styles.note}>{lang('McpRetrySeconds', { seconds: error.retryAfter })}</p>
              )}
              <Button size="tiny" color="translucent" disabled={isBusy} onClick={() => actions.refresh()}>
                {lang('McpRefresh')}
              </Button>
            </div>
          )}
          {state.recoveryCodes && (
            <section className={styles.recovery}>
              <h2 className={styles.heading}>{lang('McpRecoveryTitle')}</h2>
              <p className={styles.note}>{lang('McpRecoveryNote')}</p>
              <pre className={styles.codes}>{state.recoveryCodes.join('\n')}</pre>
              <Button onClick={() => actions.dismissRecoveryCodes()}>{lang('McpRecoverySaved')}</Button>
            </section>
          )}
          {!me ? (
            <McpAuth isBusy={isBusy} isRecovered={state.isRecovered} actions={actions} />
          ) : (
            <div className={styles.layout}>
              <nav className={styles.nav} aria-label={lang('McpTitle')}>
                {SECTIONS.map((item) => (
                  <Button
                    key={item.id}
                    size="tiny"
                    fluid
                    color={section === item.id ? 'primary' : 'translucent'}
                    ariaSelected={section === item.id}
                    onClick={() => setSection(item.id)}
                  >
                    {lang(item.label)}
                  </Button>
                ))}
              </nav>
              <div className={styles.body}>
                <p className={styles.signedIn}>{lang('McpUserLogin', { login: me.user.login })}</p>
                {section === 'telegram' && (
                  <McpTelegram
                    me={me}
                    attempt={state.attempt}
                    isBusy={isBusy}
                    browserTelegramId={browserTelegramId}
                    hasMismatch={state.hasMismatch}
                    actions={actions}
                  />
                )}
                {section === 'access' && <McpAccess policy={me.policy} isBusy={isBusy} actions={actions} />}
                {section === 'clients' && (
                  <McpClients clients={state.clients} isBusy={isBusy} actions={actions} />
                )}
                {section === 'connect' && <McpConnectionHelp mcpUrl={me.mcpUrl} />}
                {section === 'account' && (
                  <section className={styles.section}>
                    <h2 className={styles.heading}>{lang('McpAccount')}</h2>
                    <p className={styles.note}>{lang('McpAccountNote')}</p>
                    <Button color="translucent" disabled={isBusy} onClick={() => actions.logout()}>
                      {lang('McpSignOut')}
                    </Button>
                    <Button color="danger" disabled={isBusy} onClick={() => setIsDeleteOpen(true)}>
                      {lang('McpDeleteAccount')}
                    </Button>
                  </section>
                )}
              </div>
            </div>
          )}
          <footer className={styles.footer}>
            <a
              className={styles.link}
              href="/source/tg-bridge-source.tar.gz"
              target="_blank"
              rel="noopener noreferrer"
            >
              {lang('McpSource')}
            </a>
          </footer>
          <ConfirmDialog
            isOpen={isDeleteOpen && Boolean(me)}
            title={lang('McpDeleteAccount')}
            text={lang('McpDeleteConfirm')}
            confirmLabel={lang('McpDeleteAccount')}
            confirmIsDestructive
            isConfirmDisabled={!password || isBusy}
            onClose={() => {
              setPassword('');
              setIsDeleteOpen(false);
            }}
            confirmHandler={() => {
              const value = password;
              setPassword('');
              setIsDeleteOpen(false);
              void actions.deleteAccount(value);
            }}
          >
            <label className={styles.label} htmlFor="mcp-delete-password">
              {lang('McpPassword')}
            </label>
            <input
              className="form-control"
              id="mcp-delete-password"
              type="password"
              value={password}
              maxLength={1024}
              autoComplete="current-password"
              onInput={(event: React.FormEvent<HTMLInputElement>) => setPassword(event.currentTarget.value)}
            />
          </ConfirmDialog>
        </>
      )}
    </Modal>
  );
}

export default memo(McpPanel);
