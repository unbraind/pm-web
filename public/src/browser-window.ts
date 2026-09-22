/**
 * Typed view of the window properties this SPA attaches at runtime.
 *
 * Inline onclick handlers still reach `window.__app`. TypeScript call sites
 * use this accessor so the attachment does not need a global namespace.
 */

/** Methods other modules call through the window bridge. */
export interface AppBridge {
  openItemDetail(id: string): void;
  showView(view: string, pushState?: boolean): void;
  toast(message: string, type?: string): void;
  disconnectSSE(): void;
  connectSSE(projectId: string, attempt?: number): void;
  loadItemsBadge(): void;
  hideModal(id: string): void;
}

/** Window plus the properties this package writes onto it. */
export interface BrowserWindow extends Window {
  __app?: AppBridge;
  installPwa?: () => void;
  dismissInstallBanner?: () => void;
  __graphKeyHandler?: (event: KeyboardEvent) => void;
  __graphSelectNode?: (id: string) => void;
}

/** The browser `beforeinstallprompt` event, which the DOM lib does not declare. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

/**
 * Return the current window as the augmented browser window.
 *
 * The extra properties are optional and written by this package; a missing
 * window is a non-browser host and must fail loudly rather than pretend the
 * bridge exists.
 */
export function browserWindow(): BrowserWindow {
  if (typeof window === "undefined") {
    throw new Error("browser window is unavailable");
  }
  return window as BrowserWindow;
}

/**
 * Whether a DOM event is the install prompt this package listens for.
 *
 * @param event - The event delivered to a `beforeinstallprompt` listener.
 * @returns True when the event exposes `prompt` and `userChoice`.
 */
export function isBeforeInstallPromptEvent(event: Event): event is BeforeInstallPromptEvent {
  return "prompt" in event && "userChoice" in event;
}
