// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@xterm/xterm/css/xterm.css";

import App from "./App";
import { initTheme } from "./hooks/useTheme";
import { initI18n } from "./i18n";
import "./styles.css";

initTheme();

const container = document.getElementById("root");
if (!container) {
  throw new Error("root container is missing from index.html");
}

void initI18n().then(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
