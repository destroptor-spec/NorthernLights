import { useRef, useEffect, useState } from 'react';

export const useInView = (options?: IntersectionObserverInit) => {
  const ref = useRef<HTMLDivElement>(null!);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView) return;
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setInView(true);
        observer.disconnect();
      }
    }, { rootMargin: '200px', ...options });

    observer.observe(el);
    return () => observer.disconnect();
  }, [inView]);

  return [ref, inView] as const;
};
