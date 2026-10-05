/**
 * Message-addressing messages: the reason a composer submission or a tool send
 * was refused, in both languages.
 */

import { type AppText, appText } from "../app-text.ts";
import type { MessageAddressingError } from "../../shared/message-addressing.ts";

export const addressingMessages = {
  notMember: (token: string): AppText =>
    appText({
      en: `${token} is not a member of this channel`,
      "zh-CN": `${token} 不是该频道成员`,
    }),
  disabled: (name: string): AppText =>
    appText({
      en: `${name} is disabled and cannot be addressed`,
      "zh-CN": `${name} 已停用，不能被点名`,
    }),
  emptyAll: (): AppText =>
    appText({
      en: "Addressing everyone needs at least one enabled member",
      "zh-CN": "点名全体需要至少一位启用成员",
    }),
};

/** One addressing failure as an application message. */
export function addressingErrorText(error: MessageAddressingError): AppText {
  switch (error.code) {
    case "not-member":
      return addressingMessages.notMember(error.token.length > 0 ? error.token : error.employeeId);
    case "disabled":
      return addressingMessages.disabled(error.token.length > 0 ? error.token : error.employeeId);
    case "empty-all":
      return addressingMessages.emptyAll();
  }
}

export type AddressingMessages = typeof addressingMessages;
