type HandlerName =
  'onEnter'
  | 'onBackspace'
  | 'onDelete'
  | 'onEsc'
  | 'onUp'
  | 'onDown'
  | 'onLeft'
  | 'onRight'
  | 'onTab'
  | 'onSpace';
type Handler = (e: KeyboardEvent) => void | boolean;
type CaptureOptions = Partial<Record<HandlerName, Handler>>;
type HandlerEntry = { handler: Handler; isHighPriority?: boolean };
const PRIORITY_ORDER = [true, false];

const keyToHandlerName: Record<string, HandlerName> = {
  Enter: 'onEnter',
  Backspace: 'onBackspace',
  Delete: 'onDelete',
  Esc: 'onEsc',
  Escape: 'onEsc',
  ArrowUp: 'onUp',
  ArrowDown: 'onDown',
  ArrowLeft: 'onLeft',
  ArrowRight: 'onRight',
  Tab: 'onTab',
  ' ': 'onSpace',
};

const handlers: Record<HandlerName, HandlerEntry[]> = {
  onEnter: [],
  onDelete: [],
  onBackspace: [],
  onEsc: [],
  onUp: [],
  onDown: [],
  onLeft: [],
  onRight: [],
  onTab: [],
  onSpace: [],
};

export default function captureKeyboardListeners(options: CaptureOptions, isHighPriority?: boolean) {
  if (!hasActiveHandlers()) {
    document.addEventListener('keydown', handleKeyDown, true);
  }

  (Object.keys(options) as Array<HandlerName>).forEach((handlerName) => {
    const handler = options[handlerName];
    if (!handler) {
      return;
    }

    const currentEventHandlers = handlers[handlerName];
    if (currentEventHandlers) {
      currentEventHandlers.push({ handler, isHighPriority });
    }
  });

  return () => {
    releaseKeyboardListener(options, isHighPriority);
  };
}

function hasActiveHandlers() {
  return Object.values(handlers).some((keyHandlers) => Boolean(keyHandlers.length));
}

export function hasActiveHandler(key: string) {
  const handlerName = keyToHandlerName[key];
  return handlerName ? Boolean(handlers[handlerName].length) : false;
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.isComposing) {
    return;
  }

  const handlerName = keyToHandlerName[e.key];
  if (!handlerName) {
    return;
  }

  const { length } = handlers[handlerName];
  if (!length) {
    return;
  }

  for (const isHighPriority of PRIORITY_ORDER) {
    for (let i = length - 1; i >= 0; i--) {
      const entry = handlers[handlerName][i];
      if (Boolean(entry.isHighPriority) !== isHighPriority) continue;
      if (entry.handler(e) !== false) {
        e.stopPropagation();
        return;
      }
    }
  }
}

function releaseKeyboardListener(options: CaptureOptions, isHighPriority?: boolean) {
  (Object.keys(options) as Array<HandlerName>).forEach((handlerName) => {
    const handler = options[handlerName];
    const currentEventHandlers = handlers[handlerName];
    if (currentEventHandlers) {
      const index = currentEventHandlers.findIndex(
        (entry) => entry.handler === handler && entry.isHighPriority === isHighPriority,
      );
      if (index !== -1) {
        currentEventHandlers.splice(index, 1);
      }
    }
  });

  if (!hasActiveHandlers()) {
    document.removeEventListener('keydown', handleKeyDown, true);
  }
}
