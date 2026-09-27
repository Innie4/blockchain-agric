import { useEffect, useRef, type RefObject } from "react";

/**
 * Closes a popover when the reader clicks elsewhere or presses Escape.
 *
 * Both dropdowns in the header need this, and getting it right once means a
 * reader is never left with an open menu they cannot dismiss.
 */
export function useMenuDismiss<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
): RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent): void {
      const node = ref.current;
      if (node === null) return;
      const target = event.target;
      if (target instanceof Node && !node.contains(target)) onClose();
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  return ref;
}
