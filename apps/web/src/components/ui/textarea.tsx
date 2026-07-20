import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils.js';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'w-full resize-y rounded-md border border-input bg-background/80 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:border-border disabled:bg-muted/60 disabled:text-muted-foreground disabled:placeholder:text-muted-foreground/70 disabled:opacity-80',
        className,
      )}
      {...props}
    />
  );
}
