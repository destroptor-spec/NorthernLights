import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
const shortcuts = [
    { key: 'Space', description: 'Play/Pause' },
    { key: '←', description: 'Previous Track' },
    { key: '→', description: 'Next Track' },
    { key: 'M', description: 'Volume Up' },
    { key: ',', description: 'Volume Down' },
    { key: 'S', description: 'Toggle Shuffle' },
    { key: 'R', description: 'Cycle Repeat' },
];
const KeyboardHint = () => {
    const [isVisible, setIsVisible] = React.useState(true);
    React.useEffect(() => {
        // Hide hint after 5 seconds
        const timeoutId = setTimeout(() => {
            setIsVisible(false);
        }, 5000);
        // Also hide on any keypress
        const handleKeyDown = () => setIsVisible(false);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            clearTimeout(timeoutId);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, []);
    if (!isVisible) {
        return null;
    }
    return (_jsx("div", { className: "keyboard-hint", children: shortcuts.map((shortcut, index) => (_jsxs(React.Fragment, { children: [_jsxs("span", { children: [_jsx("kbd", { className: "keyboard-hint-key", children: shortcut.key }), _jsx("span", { style: { marginLeft: '8px', color: 'var(--color-text-muted)' }, children: shortcut.description })] }), index < shortcuts.length - 1 && (_jsx("span", { style: { color: 'var(--color-border)' }, children: "\u2022" }))] }, shortcut.key))) }));
};
export default KeyboardHint;
