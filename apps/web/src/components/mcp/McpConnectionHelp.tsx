import { memo, useState } from '../../lib/teact/teact';

import { copyTextToClipboard } from '../../util/clipboard';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';

import styles from './McpPanel.module.scss';

type OwnProps = { mcpUrl: string };

function McpConnectionHelp({ mcpUrl }: OwnProps) {
  const lang = useLang();
  const [isCopied, setIsCopied] = useState(false);
  const handleCopy = useLastCallback(() => {
    setIsCopied(copyTextToClipboard(mcpUrl));
  });
  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>{lang('McpConnect')}</h2>
      <label className={styles.label} htmlFor="mcp-url">
        {lang('McpUrl')}
      </label>
      <input className="form-control" id="mcp-url" value={mcpUrl} readOnly />
      <Button color="translucent" onClick={handleCopy}>
        {lang(isCopied ? 'McpCopied' : 'McpCopyUrl')}
      </Button>
      <p className={styles.note}>{lang('McpOAuthHelp')}</p>
      <div className={styles.card}>
        <strong className={styles.identity}>ChatGPT</strong>
        <p className={styles.note}>{lang('McpChatGptHelp')}</p>
        <a
          className={styles.link}
          href="https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt"
          target="_blank"
          rel="noopener noreferrer"
        >
          ChatGPT · MCP
        </a>
      </div>
      <div className={styles.card}>
        <strong className={styles.identity}>Claude</strong>
        <p className={styles.note}>{lang('McpClaudeHelp')}</p>
      </div>
      <div className={styles.card}>
        <strong className={styles.identity}>Codex / Claude Code</strong>
        <p className={styles.note}>{lang('McpCodexHelp')}</p>
        <a
          className={styles.link}
          href="https://code.claude.com/docs/en/mcp"
          target="_blank"
          rel="noopener noreferrer"
        >
          Claude Code · MCP
        </a>
      </div>
      <p className={styles.warning}>{lang('McpNoTokenHelp')}</p>
    </section>
  );
}

export default memo(McpConnectionHelp);
