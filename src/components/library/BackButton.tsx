import React from 'react';
import { ChevronLeft } from 'lucide-react';

interface BackButtonProps {
    onClick: () => void;
    children?: React.ReactNode;
}

export const BackButton: React.FC<BackButtonProps> = ({ onClick, children = 'Back to Library' }) => (
    <button
        onClick={onClick}
        className="font-medium text-sm md:text-base text-[var(--color-primary)] hover:text-[var(--color-primary-dark)] px-4 py-2 w-fit flex items-center gap-1 mb-8 md:mb-12 transition-all duration-200 motion-reduce:transition-none"
    >
        <ChevronLeft size={20} />
        {children}
    </button>
);
