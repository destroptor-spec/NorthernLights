import React from 'react';
import { CheckCircle2, AlertCircle, XCircle, Info, ArrowRight } from 'lucide-react';

export type DependencyStatus = 'available' | 'partial' | 'unavailable';

interface DependencyBadgeProps {
  label: string;
  status: DependencyStatus;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

const statusConfig = {
  available: {
    icon: CheckCircle2,
    iconColor: 'text-emerald-500',
    bgColor: 'bg-emerald-500/8',
    borderColor: 'border-emerald-500/20',
    labelColor: 'text-emerald-600 dark:text-emerald-400',
  },
  partial: {
    icon: AlertCircle,
    iconColor: 'text-amber-500',
    bgColor: 'bg-amber-500/8',
    borderColor: 'border-amber-500/20',
    labelColor: 'text-amber-600 dark:text-amber-400',
  },
  unavailable: {
    icon: XCircle,
    iconColor: 'text-red-500',
    bgColor: 'bg-red-500/8',
    borderColor: 'border-red-500/20',
    labelColor: 'text-red-600 dark:text-red-400',
  },
};

export const DependencyBadge: React.FC<DependencyBadgeProps> = ({
  label,
  status,
  message,
  actionLabel,
  onAction,
}) => {
  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <div className={`flex items-start gap-3 p-3 rounded-xl border ${config.bgColor} ${config.borderColor}`}>
      <Icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${config.iconColor}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-semibold ${config.labelColor}`}>{label}</span>
          <span className="text-xs text-[var(--color-text-muted)]">•</span>
          <span className="text-sm text-[var(--color-text-secondary)]">{message}</span>
        </div>
        {actionLabel && onAction && (
          <button
            onClick={onAction}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[var(--color-primary)] hover:underline"
          >
            {actionLabel} <ArrowRight size={12} />
          </button>
        )}
      </div>
    </div>
  );
};

interface DependencyGroupProps {
  title: string;
  children: React.ReactNode;
}

export const DependencyGroup: React.FC<DependencyGroupProps> = ({ title, children }) => {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider px-1">
        {title}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
};

interface DependencyInfoBoxProps {
  title: string;
  description: string;
  icon?: React.ReactNode;
}

export const DependencyInfoBox: React.FC<DependencyInfoBoxProps> = ({
  title,
  description,
  icon,
}) => {
  return (
    <div className="bg-[var(--color-surface)]/60 rounded-xl border border-[var(--glass-border)] p-4">
      <div className="flex items-start gap-3">
        {icon && (
          <div className="text-[var(--color-primary)] mt-0.5">{icon}</div>
        )}
        <div className="flex-1">
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h4>
          <p className="text-xs text-[var(--color-text-muted)] mt-1 leading-relaxed">{description}</p>
        </div>
      </div>
    </div>
  );
};

export const InfoBadge: React.FC<{ label: string; value: string; highlight?: boolean }> = ({
  label,
  value,
  highlight,
}) => (
  <div className="flex items-center justify-between py-1.5">
    <span className="text-xs text-[var(--color-text-muted)]">{label}</span>
    <span className={`text-xs font-medium ${highlight ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-secondary)]'}`}>
      {value}
    </span>
  </div>
);