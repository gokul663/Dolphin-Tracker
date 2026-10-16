import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Testing Library only auto-cleans when vitest globals are on; they are not, so unmount explicitly.
afterEach(() => cleanup());
