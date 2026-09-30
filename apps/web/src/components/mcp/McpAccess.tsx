import { memo, useEffect, useState } from '../../lib/teact/teact';

import type { McpPanelController } from './state';
import type { McpPolicy } from './types';

import useLang from '../../hooks/useLang';

import Button from '../ui/Button';
import ConfirmDialog from '../ui/ConfirmDialog';
import InputText from '../ui/InputText';

import styles from './McpPanel.module.scss';

type OwnProps = { policy: McpPolicy; isBusy: boolean; actions: McpPanelController };
const MAX_CHATS = 100;
const CHAT_ID = /^-?[1-9]\d{0,19}$/;

function McpAccess({ policy, isBusy, actions }: OwnProps) {
  const lang = useLang();
  const [profile, setProfile] = useState(policy.profile);
  const [chatIds, setChatIds] = useState(policy.chatIds.join(', '));
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  useEffect(() => {
    setProfile(policy.profile);
    setChatIds(policy.chatIds.join(', '));
  }, [policy]);
  const parsedIds = chatIds
    .trim()
    .split(/[,\s]+/)
    .filter(Boolean);
  const isValid = parsedIds.length <= MAX_CHATS && parsedIds.every((id) => CHAT_ID.test(id));

  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>{lang('McpAccess')}</h2>
      <p className={styles.note}>{lang('McpPolicyNote')}</p>
      <div className={styles.tabs}>
        <Button
          fluid
          ariaSelected={profile === 'read'}
          color={profile === 'read' ? 'primary' : 'translucent'}
          onClick={() => setProfile('read')}
        >
          {lang('McpRead')}
        </Button>
        <Button
          fluid
          ariaSelected={profile === 'full'}
          color={profile === 'full' ? 'primary' : 'translucent'}
          onClick={() => setProfile('full')}
        >
          {lang('McpFull')}
        </Button>
      </div>
      <InputText
        id="mcp-chats"
        value={chatIds}
        label={lang('McpChats')}
        error={!isValid ? lang('McpInvalidChats') : undefined}
        onInput={(event) => setChatIds(event.currentTarget.value)}
      />
      <p className={styles.note}>{lang('McpChatsHint')}</p>
      <Button disabled={isBusy || !isValid} onClick={() => setIsConfirmOpen(true)}>
        {lang('McpSavePolicy')}
      </Button>
      <ConfirmDialog
        isOpen={isConfirmOpen}
        title={lang('McpSavePolicy')}
        text={lang('McpPolicyConfirm')}
        confirmLabel={lang('McpConfirm')}
        onClose={() => setIsConfirmOpen(false)}
        confirmHandler={() => {
          setIsConfirmOpen(false);
          void actions.updatePolicy(profile, parsedIds);
        }}
      />
    </section>
  );
}

export default memo(McpAccess);
