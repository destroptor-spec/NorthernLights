// Theme system for Modern Web Music Player - Glassmorphism Northern Lights Edition
import React from 'react';

export interface ColorPalette {
  primary: string;
  primaryDark: string;
  secondary: string;
  background: string;
  surface: string;
  surfaceVariant: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  border: string;
  accent: string;
  error: string;
  success: string;
  auroraGreen: string;
  auroraBlue: string;
  auroraExtraGlow: string;
  auroraPink: string;
}

export interface Theme {
  name: 'glassmorphism' | 'dark' | 'light';
  colors: ColorPalette;
  borderRadius: number;
  spacing: {
    xs: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
  };
  shadows: {
    sm: string;
    md: string;
    lg: string;
    glass: string;
  };
  transitions: {
    fast: string;
    normal: string;
    slow: string;
  };
}

// Northern Lights Glassmorphism Theme
export const glassmorphismTheme: Theme = {
  name: 'glassmorphism',
  colors: {
    primary: '#22C983', // Oxygen Green
    primaryDark: '#10B981',
    secondary: '#0ea5e9', // Sky Blue
    background: '#050311', // Near-black for deep aurora visibility
    surface: 'rgba(8, 6, 22, 0.7)', // Dark semi-transparent surface
    surfaceVariant: 'rgba(18, 15, 40, 0.45)',
    textPrimary: '#f0f0f9',
    textSecondary: '#c7c7d1',
    textMuted: '#8a8a9b',
    border: 'rgba(34, 201, 131, 0.3)', // Aurora green border
    accent: '#f43f5e',
    error: '#ffcccc',
    success: '#34d399',
    auroraGreen: '#22c983',
    auroraBlue: '#0ea5e9',
    auroraExtraGlow: '#10b981',
    auroraPink: '#f43f5e',
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

export const darkTheme: Theme = {
  name: 'dark',
  colors: {
    primary: '#10B981',
    primaryDark: '#059669',
    secondary: '#0ea5e9',
    background: '#1c1b1f',
    surface: '#2d2b31',
    surfaceVariant: '#49474e',
    textPrimary: '#e7e1e9',
    textSecondary: '#c4bfd7',
    textMuted: '#8d8994',
    border: '#34d399',
    accent: '#f43f5e',
    error: '#ffcccc',
    success: '#34d399',
    auroraGreen: '#22c983',
    auroraBlue: '#0ea5e9',
    auroraExtraGlow: '#10b981',
    auroraPink: '#f43f5e',
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

export const lightTheme: Theme = {
  name: 'light',
  colors: {
    primary: '#059669',
    primaryDark: '#047857',
    secondary: '#0ea5e9',
    background: '#fdfbf7',
    surface: '#ffffff',
    surfaceVariant: '#f2edeb',
    textPrimary: '#1c1b1f',
    textSecondary: '#58545e',
    textMuted: '#736e77',
    border: '#d0cdc7',
    accent: '#e11d48',
    error: '#930000',
    success: '#059669',
    auroraGreen: '#10b981',
    auroraBlue: '#0ea5e9',
    auroraExtraGlow: '#10b981',
    auroraPink: '#f43f5e',
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

export type ThemeName = 'glassmorphism' | 'dark' | 'light';

// Context for theme
export const ThemeContext = React.createContext<Theme>(glassmorphismTheme);

export const useTheme = () => React.useContext(ThemeContext);

interface ThemeProviderProps {
  children: React.ReactNode;
  theme?: Theme;
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children, theme = glassmorphismTheme }) => {
  return <ThemeContext.Provider value={ theme }> { children } </ThemeContext.Provider>;
};

// Utility hooks
export const useDarkMode = () => {
  const theme = useTheme();
  return theme.name === 'dark';
};
