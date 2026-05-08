import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.js';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-md border border-border bg-card text-card-foreground', className)} {...props} />;
}
