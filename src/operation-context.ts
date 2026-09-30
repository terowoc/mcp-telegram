import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage<AbortSignal>();
export const operationSignal = () => context.getStore();
export function runOperation<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  return context.run(signal, task);
}
