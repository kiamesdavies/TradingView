import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons";

interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  className?: string;
  /** Align near the top (search palette) instead of centered. */
  top?: boolean;
}

/** Shared dialog chrome: backdrop click closes, focus moves into the dialog and is restored on close. Esc is global. */
export function Modal({ title, onClose, children, width = 480, className, top }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>("[autofocus], input, select, textarea, button:not(.modal-close)");
      (first ?? el).focus();
    }
    return () => prev?.focus?.();
  }, []);

  return createPortal(
    <div className={`modal-backdrop${top ? " modal-top" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`modal ${className ?? ""}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
