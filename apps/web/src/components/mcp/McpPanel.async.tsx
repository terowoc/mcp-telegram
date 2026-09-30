import type { OwnProps } from './McpPanel';

import { Bundles } from '../../util/moduleLoader';

import useModuleLoader from '../../hooks/useModuleLoader';

function McpPanelAsync(props: OwnProps) {
  const McpPanel = useModuleLoader(Bundles.Extra, 'McpPanel', !props.isOpen);
  return McpPanel ? <McpPanel {...props} /> : undefined;
}

export default McpPanelAsync;
