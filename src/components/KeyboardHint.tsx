import React from 'react';

interface Shortcut {
  key: string;
  description: string;
}

const shortcuts: Shortcut[] = [
  { key: 'Space', description: 'Play/Pause' },
  { key: '←', description: 'Previous Track' },
  { key: '→', description: 'Next Track' },
  { key: 'M', description: 'Volume Up' },
  { key: ',', description: 'Volume Down' },
  { key: 'S', description: 'Toggle Shuffle' },
  { key: 'R', description: 'Cycle Repeat' },
];

const KeyboardHint: React.FC = () => {
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

  return (
    <div className="keyboard-hint">
      {shortcuts.map((shortcut, index) => (
        <React.Fragment key={shortcut.key}>
          <span>
            <kbd className="keyboard-hint-key">{shortcut.key}</kbd>
            <span style={{ marginLeft: '8px', color: 'var(--color-text-muted)' }}>
              {shortcut.description}
            </span>
          </span>
          {index < shortcuts.length - 1 && (
            <span style={{ color: 'var(--color-border)' }}>•</span>
          )}
        </React.Fragment>
      ))}
    </div>
  );
};

export default KeyboardHint;
