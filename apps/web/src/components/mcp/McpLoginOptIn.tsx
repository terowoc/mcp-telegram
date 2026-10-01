import { memo, useState } from '../../lib/teact/teact';

import { getMcpLoginOptIn, setMcpLoginOptIn } from '../../util/mcpLogin';

import useLang from '../../hooks/useLang';

import Checkbox from '../ui/Checkbox';

function McpLoginOptIn() {
  const lang = useLang();
  const [shouldConnect, setShouldConnect] = useState(getMcpLoginOptIn);
  return (
    <div className="mcp-opt-in">
      <Checkbox
        id="mcp-login-opt-in"
        checked={shouldConnect}
        label={lang('McpAlsoConnect')}
        subLabel={lang('McpPersistentAccess')}
        onCheck={(value) => {
          setShouldConnect(value);
          setMcpLoginOptIn(value);
        }}
      />
    </div>
  );
}

export default memo(McpLoginOptIn);
