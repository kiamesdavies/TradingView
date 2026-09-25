import { createPortal } from "react-dom";
import { useStore } from "../state/store";
import { CloseIcon } from "./icons";
import { useShell } from "./shellStore";

export function Toasts() {
  const toasts = useShell((s) => s.toasts);
  const dismiss = useShell((s) => s.dismissToast);
  return createPortal(
    <div className="toasts" role="region" aria-live="polite" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === "error" || t.kind === "alert" ? "alert" : "status"}>
          <button
            type="button"
            className="toast-main"
            onClick={() => {
              if (t.symbol) useStore.getState().setSymbol(t.symbol);
              dismiss(t.id);
            }}
          >
            <div className="toast-title">{t.title}</div>
            {t.body && <div className="toast-body">{t.body}</div>}
          </button>
          <button type="button" className="icon-btn toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <CloseIcon size={12} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
