import { usePlayerStore } from '../store';

export const useToast = () => {
  const toasts = usePlayerStore((state) => state.toasts);
  const addToast = usePlayerStore((state) => state.addToast);
  const removeToast = usePlayerStore((state) => state.removeToast);

  return { toasts, addToast, removeToast };
};
