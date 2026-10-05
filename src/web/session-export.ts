/**
 * The one-click session export shared by every surface.
 *
 * The server captures the snapshot and answers with a receipt naming the saved
 * file; this hook only starts the request, reports the outcome, and hands the
 * artifact to the browser's own download flow.
 */

import { useCallback } from "react";
import type { SessionExportRequestDTO, SessionExportReceiptDTO } from "../shared/contracts.ts";
import { errorDisplay } from "../shared/i18n.ts";
import { api } from "./api.ts";
import { uiText } from "./messages.ts";
import { useApp } from "./state.tsx";

export function useSessionExport(): (target: SessionExportRequestDTO) => Promise<void> {
  const { dispatch, setError } = useApp();
  return useCallback(
    async (target: SessionExportRequestDTO): Promise<void> => {
      try {
        const receipt: SessionExportReceiptDTO = await api.exportSession(target);
        dispatch({
          type: "notice",
          text: uiText((messages) => messages.common.exportSessionSaved(receipt.path)),
        });
        const link = document.createElement("a");
        link.href = receipt.downloadUrl;
        link.download = receipt.filename;
        document.body.append(link);
        link.click();
        link.remove();
      } catch (cause) {
        setError(errorDisplay(cause));
      }
    },
    [dispatch, setError],
  );
}
