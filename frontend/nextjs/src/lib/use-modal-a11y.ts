/**
 * Minimal modal accessibility (Phase 4): Escape-to-close, focus trap, and
 * focus restore. Ref + event listeners only — no DOM mutation, per the
 * project's no-direct-DOM rule (window/element listeners in an effect with
 * cleanup are the sanctioned exception).
 *
 * Pass `onClose: null` to leave Escape to the caller (the editor page closes
 * its dialogs from one document-level handler). `initialFocusRef` picks what
 * is focused on open — e.g. Cancel on a destructive confirm — instead of the
 * first focusable element.
 */
import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open modals, innermost last. Only the innermost one handles Tab and
 *  Escape: a dialog opened over the canvas editor sits outside the editor's
 *  container, and the editor's trap would otherwise pull focus back out of it. */
const openModals: symbol[] = [];

export function useModalA11y(
  containerRef: RefObject<HTMLElement | null>,
  onClose: (() => void) | null,
  active = true,
  initialFocusRef?: RefObject<HTMLElement | null>,
): void {
  // Read through a ref: a caller passing a new function every render must not
  // re-run the effect below, which would bounce focus to the opener and back.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return;
    const token = Symbol('modal');
    openModals.push(token);
    const container = containerRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Focus the chosen element, else the first focusable one, else the container.
    const focusables = () =>
      Array.from(container?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
        .filter(el => el.offsetParent !== null || el === document.activeElement);
    const first = initialFocusRef?.current ?? focusables()[0];
    (first ?? container)?.focus?.();

    const onKeyDown = (e: KeyboardEvent) => {
      if (openModals[openModals.length - 1] !== token) return;
      if (e.key === 'Escape') {
        const close = onCloseRef.current;
        if (!close) return;
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const activeEl = document.activeElement;
      // Focus outside the dialog (a click on the page behind it, or on plain
      // text that left focus on <body>): Tab brings it back in, at the start
      // (or the end, with Shift), instead of walking the page behind.
      if (!container?.contains(activeEl)) {
        e.preventDefault();
        (e.shiftKey ? lastEl : firstEl).focus();
        return;
      }
      if (e.shiftKey && activeEl === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && activeEl === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const at = openModals.indexOf(token);
      if (at !== -1) openModals.splice(at, 1);
      // Restore focus to whatever opened the modal.
      previouslyFocused?.focus?.();
    };
  }, [containerRef, active, initialFocusRef]);
}
