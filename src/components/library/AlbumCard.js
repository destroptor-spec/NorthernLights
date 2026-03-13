import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { AlbumArt } from '../AlbumArt';
export const AlbumCard = ({ title, artist, artUrl, subtitle, onPlay, onOpen }) => {
    return (_jsxs("div", { className: "album-card group flex flex-col cursor-pointer", onClick: onOpen, children: [_jsxs("div", { className: "relative aspect-square w-full mb-3 rounded-2xl border border-[var(--glass-border)] bg-[var(--color-surface)] shadow-[var(--shadow-md)] overflow-hidden", children: [_jsx(AlbumArt, { artUrl: artUrl, artist: artist, album: title, size: 400, className: "w-full h-full object-cover" }), _jsx("div", { className: "absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-all duration-300 flex items-center justify-center", children: _jsx("button", { onClick: (e) => { e.stopPropagation(); onPlay(e); }, "aria-label": `Play ${title}`, className: "\n                            w-14 h-14 rounded-full\n                            flex items-center justify-center\n                            opacity-0 scale-75\n                            group-hover:opacity-100 group-hover:scale-100\n                            transition-all duration-300 ease-out\n                            hover:scale-110\n                        ", style: {
                                background: 'linear-gradient(145deg, rgba(139, 92, 246, 0.9), rgba(109, 40, 217, 0.95))',
                                border: '1px solid rgba(168, 85, 247, 0.5)',
                                backdropFilter: 'blur(20px)',
                                WebkitBackdropFilter: 'blur(20px)',
                                boxShadow: '0 0 28px rgba(139, 92, 246, 0.55), inset 0 1px 0 rgba(255,255,255,0.2)',
                                color: '#fff',
                            }, children: _jsx("svg", { viewBox: "0 0 24 24", fill: "currentColor", className: "w-6 h-6", children: _jsx("path", { d: "M8 5v14l11-7z" }) }) }) })] }), _jsxs("div", { className: "flex flex-col px-1", children: [_jsx("div", { className: "font-semibold text-sm md:text-base tracking-wide truncate text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors", children: title }), subtitle && (_jsx("div", { className: "text-xs md:text-sm text-[var(--color-text-secondary)] truncate", children: subtitle }))] })] }));
};
