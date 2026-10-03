import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "./state.tsx";
import { ThemeProvider, initializeTheme } from "./theme.tsx";
import { LanguageProvider, initializeLanguage } from "./i18n.tsx";
import { App } from "./App.tsx";
import "./styles.css";

// The stored language and theme must be on <html> before React paints, or the
// window flashes the wrong document language or palette on load.
initializeLanguage();
initializeTheme();

const container = document.getElementById("root");
if (container === null) throw new Error("Missing #root container");
createRoot(container).render(
  <StrictMode>
    <LanguageProvider>
      <ThemeProvider>
        <AppProvider>
          <App />
        </AppProvider>
      </ThemeProvider>
    </LanguageProvider>
  </StrictMode>,
);
