import { jsx as _jsx } from "react/jsx-runtime";
export const BackButton = ({ onClick, children = '← Back to Library' }) => (_jsx("button", { onClick: onClick, className: "font-medium text-sm md:text-base text-[var(--color-primary)] hover:text-[var(--color-primary-dark)] px-4 py-2 w-fit flex items-center gap-2 mb-8 md:mb-12 transition-all duration-200", children: children }));
