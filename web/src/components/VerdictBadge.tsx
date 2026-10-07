import { IconAlertTriangle, IconCheck, IconCritical, IconInfo, IconShield } from './Icons';

interface VerdictBadgeProps {
  verdict: string;
  small?: boolean;
}

export function VerdictBadge({ verdict, small }: VerdictBadgeProps) {
  const norm = verdict.toUpperCase();

  const getIcon = () => {
    switch (norm) {
      case 'PASS':
        return <IconCheck style={{ width: small ? 12 : 14, height: small ? 12 : 14 }} />;
      case 'PASS_WITH_WARNINGS':
        return <IconAlertTriangle style={{ width: small ? 12 : 14, height: small ? 12 : 14 }} />;
      case 'FAILED':
        return <IconCritical style={{ width: small ? 12 : 14, height: small ? 12 : 14 }} />;
      case 'BLOCKED_PENDING_REVIEW':
        return <IconShield style={{ width: small ? 12 : 14, height: small ? 12 : 14 }} />;
      case 'INCOMPLETE':
        return <IconInfo style={{ width: small ? 12 : 14, height: small ? 12 : 14 }} />;
      default:
        return <IconInfo style={{ width: small ? 12 : 14, height: small ? 12 : 14 }} />;
    }
  };

  const formatted = verdict.replace(/_/g, ' ');

  return (
    <span className={`verdict-pill v-${norm} ${small ? 'verdict-pill-sm' : ''}`}>
      <span className="verdict-icon">{getIcon()}</span>
      <span className="verdict-label">{formatted}</span>
    </span>
  );
}
