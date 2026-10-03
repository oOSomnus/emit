/**
 * MCP connection messages. Native connection failures, stderr output, tool
 * descriptions, and server output stay raw; only the app-authored success and
 * server-not-found lines, plus the boot-time connection-failure notice, carry
 * a pair. The persisted `connectionMessage` is never given a companion.
 */

import type { AppText } from "../app-text.ts";
import { appText } from "../app-text.ts";

export const mcpMessages = {
  serverMissing: (id: string): AppText =>
    appText({
      en: `MCP server not found: ${id}`,
      "zh-CN": `MCP server 不存在: ${id}`,
    }),

  /** `toolCount` is discovered by the real connection. */
  connected: (toolCount: number): AppText =>
    appText({
      en: `Connected, found ${toolCount} tools`,
      "zh-CN": `已连接，发现 ${toolCount} 个工具`,
    }),

  /**
   * Boot-time notice for a server that failed to connect. `serverName` is user
   * data and `reason` is the raw native failure; both are embedded unchanged.
   */
  connectionFailedNotice: (serverName: string, reason: string): AppText =>
    appText({
      en: `MCP server ${serverName} connection failed: ${reason}`,
      "zh-CN": `MCP server ${serverName} 连接失败：${reason}`,
    }),
};
