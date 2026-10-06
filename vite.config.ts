import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The server auto-allocates its port unless EMIT_PORT names one explicitly, so
// the dev proxy only exists when the environment pins a usable port.
const emitPort = Number(process.env.EMIT_PORT ?? 0);
const proxyPort = Number.isInteger(emitPort) && emitPort > 0 ? emitPort : undefined;

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    // Split vendor code into cacheable chunks; react-dom alone exceeds the
    // 500 kB warning limit when it shares one bundle with the markdown stack.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules[\\/](?:react-dom|react|scheduler)[\\/]/,
              priority: 20,
            },
            {
              name: "markdown-vendor",
              test: /node_modules[\\/](?:react-markdown|remark-gfm)[\\/]/,
              priority: 10,
              includeDependenciesRecursively: true,
            },
          ],
        },
      },
    },
  },
  ...(proxyPort === undefined
    ? {}
    : {
        server: {
          proxy: {
            "/api": `http://127.0.0.1:${proxyPort}`,
          },
        },
      }),
});
