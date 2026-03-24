import { jsxs as _jsxs } from "react/jsx-runtime";
// Theme system for Modern Web Music Player - Glassmorphism Northern Lights Edition
import React from 'react';
// Northern Lights Glassmorphism Theme
export const glassmorphismTheme = {
    name: 'glassmorphism',
    colors: {
        primary: '#8B5CF6', // Violet
        primaryDark: '#7C3AED',
        secondary: '#10B981', // Emerald
        background: '#050311', // Near-black for deep aurora visibility
        surface: 'rgba(8, 6, 22, 0.7)', // Dark semi-transparent surface
        surfaceVariant: 'rgba(18, 15, 40, 0.45)',
        textPrimary: '#f0f0f9',
        textSecondary: '#c7c7d1',
        textMuted: '#8a8a9b',
        border: 'rgba(139, 92, 246, 0.3)', // Aurora violet border
        accent: '#03dac6',
        error: '#ffcccc',
        success: '#03dac6',
        auroraGreen: '#34d399',
        auroraBlue: '#60a5fa',
        auroraPurple: '#8b5cf6',
        auroraPink: '#f472b6',
    },
    borderRadius: 16,
    spacing: {
        xs: 4,
        sm: 8,
        md: 16,
        lg: 24,
        xl: 32,
    },
    shadows: {
        sm: '0 2px 4px rgba(0, 0, 0, 0.2)',
        md: '0 8px 24px rgba(0, 0, 0, 0.3)',
        lg: '0 16px 48px rgba(0, 0, 0, 0.4)',
        glass: 'rgba(255, 255, 255, 0.05) 0px 5px 15px, rgba(0, 0, 0, 0.2) 0px 0px 30px inset',
    },
    transitions: {
        fast: '200ms cubic-bezier(0.4, 0, 0.2, 1)',
        normal: '350ms cubic-bezier(0.4, 0, 0.2, 1)',
        slow: '500ms cubic-bezier(0.4, 0, 0.2, 1)',
    },
};
export const darkTheme = {
    name: 'dark',
    colors: {
        primary: '#6750a4',
        primaryDark: '#524783',
        secondary: '#6d5c7a',
        background: '#1c1b1f',
        surface: '#2d2b31',
        surfaceVariant: '#49474e',
        textPrimary: '#e7e1e9',
        textSecondary: '#c4bfd7',
        textMuted: '#8d8994',
        border: '#8d8994',
        accent: '#03dac6',
        error: '#ffcccc',
        success: '#03dac6',
        auroraGreen: '#34d399',
        auroraBlue: '#60a5fa',
        auroraPurple: '#8b5cf6',
        auroraPink: '#f472b6',
    },
    borderRadius: 8,
    spacing: {
        xs: 4,
        sm: 8,
        md: 16,
        lg: 24,
        xl: 32,
    },
    shadows: {
        sm: '0 1px 2px rgba(0, 0, 0, 0.3)',
        md: '0 4px 6px rgba(0, 0, 0, 0.4)',
        lg: '0 8px 12px rgba(0, 0, 0, 0.5)',
        glass: 'rgba(255, 255, 255, 0.05) 0px 5px 15px, rgba(0, 0, 0, 0.2) 0px 0px 30px inset',
    },
    transitions: {
        fast: '150ms ease-in-out',
        normal: '250ms ease-in-out',
        slow: '350ms ease-in-out',
    },
};
export const lightTheme = {
    name: 'light',
    colors: {
        primary: '#6750a4',
        primaryDark: '#4e3d8c',
        secondary: '#6d5c7a',
        background: '#fdfbf7',
        surface: '#ffffff',
        surfaceVariant: '#f2edeb',
        textPrimary: '#1c1b1f',
        textSecondary: '#58545e',
        textMuted: '#736e77',
        border: '#d0cdc7',
        accent: '#03dac6',
        error: '#930000',
        success: '#4caf50',
        auroraGreen: '#34d399',
        auroraBlue: '#60a5fa',
        auroraPurple: '#8b5cf6',
        auroraPink: '#f472b6',
    },
    borderRadius: 8,
    spacing: {
        xs: 4,
        sm: 8,
        md: 16,
        lg: 24,
        xl: 32,
    },
    shadows: {
        sm: '0 1px 2px rgba(0, 0, 0, 0.1)',
        md: '0 2px 4px rgba(0, 0, 0, 0.15)',
        lg: '0 4px 8px rgba(0, 0, 0, 0.2)',
        glass: 'rgba(0, 0, 0, 0.05) 0px 5px 15px, rgba(255, 255, 255, 0.5) 0px 0px 30px inset',
    },
    transitions: {
        fast: '150ms ease-in-out',
        normal: '250ms ease-in-out',
        slow: '350ms ease-in-out',
    },
};
// Context for theme
export const ThemeContext = React.createContext(glassmorphismTheme);
export const useTheme = () => React.useContext(ThemeContext);
export const ThemeProvider = ({ children, theme = glassmorphismTheme }) => {
    return _jsxs(ThemeContext.Provider, { value: theme, children: [" ", children, " "] });
};
// Utility hooks
export const useDarkMode = () => {
    const theme = useTheme();
    return theme.name === 'dark';
};
