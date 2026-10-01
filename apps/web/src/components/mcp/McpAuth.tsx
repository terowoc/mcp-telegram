import { memo, useState } from '../../lib/teact/teact';

import type { McpPanelController } from './state';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';
import InputText from '../ui/InputText';

import styles from './McpPanel.module.scss';

type OwnProps = { isBusy: boolean; isRecovered?: boolean; shouldShowLegacy?: boolean; actions: McpPanelController };

function McpAuth({ isBusy, isRecovered, shouldShowLegacy, actions }: OwnProps) {
  const lang = useLang();
  const [isLegacyOpen, setIsLegacyOpen] = useState(Boolean(shouldShowLegacy));
  const [mode, setMode] = useState<'login' | 'register' | 'recover'>('login');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const handleSubmit = useLastCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      if (mode === 'register') await actions.register(login, password);
      else if (mode === 'recover') await actions.recover(login, recoveryCode, password);
      else await actions.login(login, password);
    } finally {
      setPassword('');
      setRecoveryCode('');
    }
  });
  const handleMode = useLastCallback((next: typeof mode) => {
    setMode(next);
    setPassword('');
    setRecoveryCode('');
  });

  return (
    <section className={styles.auth}>
      {isRecovered && <p className={styles.note} role="status">{lang('McpRecovered')}</p>}
      <div className={styles.badge}>{lang('McpFree')}</div>
      <h2 className={styles.heading}>{lang('McpIntro')}</h2>
      <p className={styles.note}>{lang('McpAccountNote')}</p>
      <Button size="tiny" color="translucent" onClick={() => setIsLegacyOpen(!isLegacyOpen)}>
        {lang('McpLegacyEntry')}
      </Button>
      {isLegacyOpen && (
        <>
          <div className={styles.tabs}>
            <Button
              fluid
              size="tiny"
              color={mode === 'login' ? 'primary' : 'translucent'}
              onClick={() => handleMode('login')}
            >
              {lang('McpSignIn')}
            </Button>
            <Button
              fluid
              size="tiny"
              color={mode === 'register' ? 'primary' : 'translucent'}
              onClick={() => handleMode('register')}
            >
              {lang('McpRegister')}
            </Button>
            <Button
              fluid
              size="tiny"
              color={mode === 'recover' ? 'primary' : 'translucent'}
              onClick={() => handleMode('recover')}
            >
              {lang('McpRecover')}
            </Button>
          </div>
          <form className={styles.form} onSubmit={handleSubmit}>
            <InputText
              id="mcp-login"
              value={login}
              label={lang('McpLogin')}
              maxLength={32}
              autoComplete="username"
              onInput={(event) => setLogin(event.currentTarget.value)}
            />
            {mode === 'recover' && (
              <InputText
                id="mcp-recovery"
                value={recoveryCode}
                label={lang('McpRecoveryCode')}
                maxLength={128}
                autoComplete="off"
                onInput={(event) => setRecoveryCode(event.currentTarget.value)}
              />
            )}
            <div className="input-group with-label touched">
              <label className={styles.label} htmlFor="mcp-password">
                {lang(mode === 'recover' ? 'McpNewPassword' : 'McpPassword')}
              </label>
              <input
                className="form-control"
                id="mcp-password"
                type="password"
                value={password}
                minLength={16}
                maxLength={1024}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                onInput={(event: React.FormEvent<HTMLInputElement>) => setPassword(event.currentTarget.value)}
              />
            </div>
            <p className={styles.note}>{lang('McpPasswordHint')}</p>
            <Button type="submit" isLoading={isBusy} disabled={isBusy || !login || password.length < 16}>
              {lang(mode === 'register' ? 'McpRegister' : mode === 'recover' ? 'McpRecover' : 'McpSignIn')}
            </Button>
          </form>
        </>
      )}
    </section>
  );
}

export default memo(McpAuth);
