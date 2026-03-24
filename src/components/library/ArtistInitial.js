import { jsx as _jsx } from "react/jsx-runtime";
export const ArtistInitial = ({ name, className }) => (_jsx("span", { className: className ?? 'text-4xl md:text-6xl text-[var(--color-primary)] opacity-50', children: name.charAt(0) }));
