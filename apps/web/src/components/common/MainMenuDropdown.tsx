import { type FC, memo, useEffect, useState } from '@teact';
import { APP_REVISION } from 'virtual:git-info';
import { getActions, withGlobal } from '../../global';

import { LeftColumnContent, SettingsScreens } from '../../types';

import { APP_NAME, DEBUG, IS_BETA } from '../../config';
import { requestMutation } from '../../lib/fasterdom/fasterdom';
import buildClassName from '../../util/buildClassName';
import { consumeMcpLoginEntry } from '../../util/mcpLogin';

import useFlag from '../../hooks/useFlag';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import useLeftHeaderButtonRtlForumTransition from '../left/main/hooks/useLeftHeaderButtonRtlForumTransition';

import LeftSideMenuItems from '../left/main/LeftSideMenuItems';
import McpPanelAsync from '../mcp/McpPanel.async';
import DropdownMenu from '../ui/DropdownMenu';

type OwnProps = {
  trigger?: FC<{ onTrigger: () => void; isOpen?: boolean }>;
  shouldHideSearch?: boolean;
  className?: string;
};

type StateProps = { browserTelegramId?: string };

const LeftSideMenuDropdown = ({
  trigger,
  shouldHideSearch,
  className,
  browserTelegramId,
}: OwnProps & StateProps) => {
  const { openLeftColumnContent, closeForumPanel, closeCommunityPanel, openSettingsScreen } = getActions();
  const [isBotMenuOpen, markBotMenuOpen, unmarkBotMenuOpen] = useFlag();
  const [isMcpOpen, openMcp, closeMcp] = useFlag();
  const lang = useLang();
  const [shouldStartMcp, setShouldStartMcp] = useState(false);
  useEffect(() => {
    if (!browserTelegramId) return;
    const entry = consumeMcpLoginEntry();
    if (entry) {
      setShouldStartMcp(entry.shouldStart);
      openMcp();
    }
  }, [browserTelegramId, openMcp]);

  const versionString = IS_BETA
    ? `${APP_VERSION} Beta (${APP_REVISION})`
    : DEBUG
      ? APP_REVISION
      : APP_VERSION;

  // Disable dropdown menu RTL animation for resize
  const { shouldDisableDropdownMenuTransitionRef, handleDropdownMenuTransitionEnd } =
    useLeftHeaderButtonRtlForumTransition(shouldHideSearch);

  const handleSelectMcp = useLastCallback(() => {
    const triggerButton = document.querySelector<HTMLElement>('.DropdownMenu.main-menu > button');
    requestMutation(() => {
      triggerButton?.focus();
      openMcp();
    });
  });

  const handleSelectSettings = useLastCallback(() => {
    openSettingsScreen({ screen: SettingsScreens.Main });
  });

  const handleSelectContacts = useLastCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.Contacts });
  });

  const handleSelectArchived = useLastCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.Archived });
    closeForumPanel();
    closeCommunityPanel();
  });

  return (
    <>
      <DropdownMenu
        trigger={trigger}
        className={buildClassName(
          'main-menu',
          lang.isRtl && 'rtl',
          shouldHideSearch && lang.isRtl && 'right-aligned',
          shouldDisableDropdownMenuTransitionRef.current && lang.isRtl && 'disable-transition',
          className,
        )}
        forceOpen={isBotMenuOpen}
        positionX={shouldHideSearch && lang.isRtl ? 'right' : 'left'}
        transformOriginX={90}
        transformOriginY={100}
        withPortal
        onTransitionEnd={lang.isRtl ? handleDropdownMenuTransitionEnd : undefined}
      >
        <LeftSideMenuItems
          onSelectArchived={handleSelectArchived}
          onSelectContacts={handleSelectContacts}
          onSelectSettings={handleSelectSettings}
          onBotMenuOpened={markBotMenuOpen}
          onBotMenuClosed={unmarkBotMenuOpen}
          footer={`${APP_NAME} ${versionString}`}
          onSelectMcp={handleSelectMcp}
        />
      </DropdownMenu>
      <McpPanelAsync
        isOpen={isMcpOpen}
        browserTelegramId={browserTelegramId}
        shouldStart={shouldStartMcp}
        onClose={() => {
          setShouldStartMcp(false);
          closeMcp();
        }}
      />
    </>
  );
};

export default memo(
  withGlobal<OwnProps>(
    (global): Complete<StateProps> => ({
      browserTelegramId: global.currentUserId,
    }),
  )(LeftSideMenuDropdown),
);
