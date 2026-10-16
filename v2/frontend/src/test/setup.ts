import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Testing Library only auto-cleans when vitest globals are on; they are not, so unmount explicitly.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// jsdom lacks these; Recharts (ResizeObserver) and Radix (pointer capture, scrollIntoView) call them.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
