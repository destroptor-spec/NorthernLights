import { jsx as _jsx } from "react/jsx-runtime";
export const FadedHeroImage = ({ src }) => (_jsx("div", { className: "absolute top-0 left-0 w-full h-[300px] md:h-[400px] z-0 opacity-40 mix-blend-overlay pointer-events-none", style: {
        background: `url(${src}) center/cover no-repeat`,
        maskImage: 'linear-gradient(to bottom, black 0%, transparent 100%)',
        WebkitMaskImage: 'linear-gradient(to bottom, black 0%, transparent 100%)',
    } }));
