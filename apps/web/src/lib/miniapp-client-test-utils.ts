import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
export interface ClientOptions {
  source?: { addEventListener(type: string, listener: EventListener): void; removeEventListener(type: string, listener: EventListener): void };
  target?: { postMessage(message: unknown, origin: string): void };
  createId?: () => string;
  timeoutMs?: number;
  captureReady?: boolean;
}
export interface MiniappClient {
  invoke(method: string, params?: Record<string, unknown>): Promise<unknown>;
  ready(): Promise<void>;
  state: { get(key: string): Promise<unknown>; set(key: string, value: Record<string, unknown>): Promise<void> };
  destroy(): void;
}
interface BridgeApi {
  createMiniappClient(options: ClientOptions): MiniappClient;
  MiniappBridgeError: new (code: string, message: string) => Error;
}
const context: { MiniappBridge?: BridgeApi; setTimeout: (callback: () => void, delay?: number) => ReturnType<typeof setTimeout>; clearTimeout: (timer: ReturnType<typeof setTimeout>) => void } = {
  setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: (timer) => clearTimeout(timer),
};
runInNewContext(readFileSync(new URL('../../public/miniapps/bridge.js', import.meta.url), 'utf8'), context);
if (!context.MiniappBridge) throw new Error('실제 bridge.js의 팩토리가 없어요');
export const { createMiniappClient, MiniappBridgeError } = context.MiniappBridge;
