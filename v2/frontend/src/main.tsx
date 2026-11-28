import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "@/app/App";
import { reloadOnStalePage } from "@/lib/freshPage";
import { initTheme } from "@/lib/theme";

reloadOnStalePage();
initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
