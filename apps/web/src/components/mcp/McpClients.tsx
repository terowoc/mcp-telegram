import { memo, useState } from '../../lib/teact/teact';

import type { McpPanelController } from './state';
import type { McpClient } from './types';

import useLang from '../../hooks/useLang';

import Button from '../ui/Button';
import ConfirmDialog from '../ui/ConfirmDialog';

import styles from './McpPanel.module.scss';

type OwnProps = { clients: McpClient[]; isBusy: boolean; actions: McpPanelController };

function McpClients({ clients, isBusy, actions }: OwnProps) {
  const lang = useLang();
  const [revokingId, setRevokingId] = useState<string>();
  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>{lang('McpClients')}</h2>
      {!clients.length && <p className={styles.note}>{lang('McpNoClients')}</p>}
      {clients.map((client) => (
        <div className={styles.client} key={client.grantId}>
          <code className={styles.clientId}>{client.clientId}</code>
          <Button fluid size="tiny" color="danger" disabled={isBusy} onClick={() => setRevokingId(client.grantId)}>
            {lang('McpRevoke')}
          </Button>
        </div>
      ))}
      <ConfirmDialog
        isOpen={Boolean(revokingId)}
        title={lang('McpRevoke')}
        text={lang('McpRevokeConfirm')}
        confirmLabel={lang('McpConfirm')}
        confirmIsDestructive
        onClose={() => setRevokingId(undefined)}
        confirmHandler={() => {
          if (revokingId) void actions.revokeClient(revokingId);
          setRevokingId(undefined);
        }}
      />
    </section>
  );
}

export default memo(McpClients);
