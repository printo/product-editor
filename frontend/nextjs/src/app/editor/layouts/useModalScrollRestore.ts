/**
 * Whether the layout editor is open, remembering where the list was scrolled
 * to when it opened. The page is held to the height under the header while the
 * editor is open, which clamps the scroll position to the top; it is put back
 * on close. Moved out of page.tsx unchanged (docs/LAYOUTS_PAGE_SPLIT_PLAN.md, step 3).
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export function useModalScrollRestore() {
  const [isModalOpen, setIsModalOpenState] = useState(false);
  const scrollBeforeModal = useRef(0);
  const setIsModalOpen = useCallback((open: boolean) => {
    if (open) scrollBeforeModal.current = window.scrollY;
    setIsModalOpenState(open);
  }, []);
  const modalWasOpen = useRef(false);
  useLayoutEffect(() => {
    if (!isModalOpen && modalWasOpen.current) window.scrollTo(0, scrollBeforeModal.current);
    modalWasOpen.current = isModalOpen;
  }, [isModalOpen]);
  return [isModalOpen, setIsModalOpen] as const;
}
