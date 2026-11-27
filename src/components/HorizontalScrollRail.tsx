import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface HorizontalScrollRailProps {
  children: React.ReactNode;
  className?: string;
  viewportClassName?: string;
  ariaLabel: string;
  role?: React.AriaRole;
}

export const HorizontalScrollRail: React.FC<HorizontalScrollRailProps> = ({
  children,
  className = '',
  viewportClassName = '',
  ariaLabel,
  role,
}) => {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;
    setCanScrollLeft(viewport.scrollLeft > 1);
    setCanScrollRight(viewport.scrollLeft < maxScrollLeft - 1);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    updateScrollState();
    const resizeObserver = new ResizeObserver(updateScrollState);
    resizeObserver.observe(viewport);

    Array.from(viewport.children).forEach((child) => resizeObserver.observe(child));
    viewport.addEventListener('scroll', updateScrollState, { passive: true });
    window.addEventListener('resize', updateScrollState);

    return () => {
      resizeObserver.disconnect();
      viewport.removeEventListener('scroll', updateScrollState);
      window.removeEventListener('resize', updateScrollState);
    };
  }, [children, updateScrollState]);

  const scrollByPage = (direction: -1 | 1) => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    viewport.scrollBy({
      left: direction * Math.max(viewport.clientWidth * 0.85, 240),
      behavior: 'smooth',
    });
  };

  const buttonClass =
    'hidden md:flex absolute top-1/2 z-20 h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] text-[var(--color-text-primary)] shadow-md backdrop-blur-xl transition-ui hover:bg-[var(--glass-bg-hover)] hover:text-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-primary/40';

  return (
    <div className={`relative ${className}`}>
      <div
        ref={viewportRef}
        className={`hide-scrollbar rail-lift-room ${viewportClassName}`}
        aria-label={ariaLabel}
        role={role}
      >
        {children}
      </div>

      {canScrollLeft && (
        <button
          type="button"
          className={`${buttonClass} -left-3`}
          onClick={() => scrollByPage(-1)}
          aria-label={`Scroll ${ariaLabel} left`}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
      )}

      {canScrollRight && (
        <button
          type="button"
          className={`${buttonClass} -right-3`}
          onClick={() => scrollByPage(1)}
          aria-label={`Scroll ${ariaLabel} right`}
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      )}
    </div>
  );
};
