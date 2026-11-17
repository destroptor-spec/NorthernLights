import React from 'react';
import { useContextMenuTrigger } from '../hooks/useContextMenuTrigger';

type ContextMenuTargetProps = React.HTMLAttributes<HTMLDivElement> & {
  /** Opens the item's menu at (x, y), as its ⋯ button does. */
  onOpenMenu: (x: number, y: number) => void;
};

/**
 * A div whose menu opens by right-click or a long press
 * (useContextMenuTrigger), for rows rendered inside a `.map` where a hook
 * can't be called.
 */
export function ContextMenuTarget({ onOpenMenu, ...rest }: ContextMenuTargetProps) {
  const trigger = useContextMenuTrigger(onOpenMenu);
  return <div {...rest} {...trigger} />;
}
