export function VerdictBadge({ verdict, small }: { verdict: string; small?: boolean }) {
  return <span className={`verdict v-${verdict} ${small ? 'small' : ''}`}>{verdict.replace(/_/g, ' ')}</span>;
}
