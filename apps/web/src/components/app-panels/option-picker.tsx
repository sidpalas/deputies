import { useEffect, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { BranchOption, RepositoryOption } from '../../api.js';
import { cn } from '../../lib/utils.js';
import { Input } from '../ui/input.js';

const optionPickerOpenEvent = 'deputies-option-picker-open';

export type OptionPickerOption = {
  value: string;
  label: string;
  available?: boolean;
  unavailableReason?: string;
  action?: string;
};

export function RepositoryPicker(props: {
  id?: string;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  direction?: 'up' | 'down';
  value: string;
  repositories: RepositoryOption[];
  loading: boolean;
  error: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <OptionPicker
      {...(props.id ? { id: props.id } : {})}
      {...(props.className ? { className: props.className } : {})}
      {...(props.triggerClassName ? { triggerClassName: props.triggerClassName } : {})}
      menuClassName="min-w-72"
      {...(props.direction ? { direction: props.direction } : {})}
      label="Repository"
      value={props.value}
      options={props.repositories.map((repository) => ({ value: repository.fullName, label: repository.fullName }))}
      emptyLabel={props.loading ? 'Loading repositories...' : props.placeholder}
      loading={props.loading}
      error={props.error ? 'Could not load repositories.' : ''}
      searchable
      allowEmpty={Boolean(props.value)}
      onChange={props.onChange}
      disabled={props.disabled}
    />
  );
}

export function BranchPicker(props: {
  id?: string;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  direction?: 'up' | 'down';
  value: string;
  branches: BranchOption[];
  loading: boolean;
  error: string;
  placeholder?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <OptionPicker
      {...(props.id ? { id: props.id } : {})}
      {...(props.className ? { className: props.className } : {})}
      {...(props.triggerClassName ? { triggerClassName: props.triggerClassName } : {})}
      menuClassName="min-w-72"
      {...(props.direction ? { direction: props.direction } : {})}
      label="Branch"
      value={props.value}
      options={props.branches.map((branch) => ({ value: branch.name, label: branch.name }))}
      emptyLabel={
        props.loading
          ? 'Loading branches...'
          : props.placeholder || (props.branches.length ? 'Select branch...' : 'No branches')
      }
      loading={props.loading}
      error={props.error ? 'Could not load branches.' : ''}
      allowCustom
      allowEmpty={Boolean(props.value)}
      onChange={props.onChange}
      disabled={props.disabled}
    />
  );
}

export function OptionPicker(props: {
  id?: string;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  direction?: 'up' | 'down';
  label: string;
  value: string;
  options: OptionPickerOption[];
  emptyLabel: string;
  loading?: boolean;
  error?: string;
  searchable?: boolean;
  allowCustom?: boolean;
  allowEmpty?: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const pickerId = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = props.options.find((option) => option.value === props.value);
  const displayLabel = selected?.label ?? (props.value && props.allowCustom ? props.value : props.emptyLabel);
  const filteredOptions = props.options.filter((option) =>
    `${option.label} ${option.value}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const customValue = search.trim();
  const showCustom = props.allowCustom && customValue && !props.options.some((option) => option.value === customValue);
  const disabled = props.disabled;
  const direction = props.direction ?? 'down';

  useEffect(() => {
    function closeOtherPicker(event: Event) {
      if (!(event instanceof CustomEvent) || event.detail === pickerId) return;
      setOpen(false);
    }

    window.addEventListener(optionPickerOpenEvent, closeOtherPicker);
    return () => window.removeEventListener(optionPickerOpenEvent, closeOtherPicker);
  }, [pickerId]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function select(value: string) {
    if (props.options.find((option) => option.value === value)?.available === false) return;
    props.onChange(value);
    setSearch('');
    setOpen(false);
  }

  function toggleOpen() {
    setOpen((current) => {
      const next = !current;
      if (next) window.dispatchEvent(new CustomEvent(optionPickerOpenEvent, { detail: pickerId }));
      return next;
    });
  }

  return (
    <div
      className={cn('relative', props.className)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        id={props.id}
        type="button"
        className={cn(
          'relative flex h-10 w-full items-center rounded-md border border-input bg-background/80 py-0 pl-3 pr-12 text-left text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:border-border disabled:bg-muted/60 disabled:text-muted-foreground disabled:opacity-80',
          props.triggerClassName,
        )}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={props.label}
        onClick={toggleOpen}
      >
        <span className="truncate" title={displayLabel}>
          {displayLabel}
        </span>
        <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      </button>
      {open ? (
        <div
          className={cn(
            'absolute left-0 right-0 z-30 overflow-auto rounded-md border border-border bg-card p-1 text-sm text-foreground shadow-xl',
            direction === 'up' ? 'bottom-full mb-1 max-h-[min(60vh,28rem)]' : 'top-full mt-1 max-h-80',
            props.menuClassName,
          )}
          role="listbox"
        >
          {(props.searchable || props.options.length > 8 || props.allowCustom) && !props.loading ? (
            <Input
              className="mb-1 h-8 bg-background text-xs"
              value={search}
              placeholder={props.allowCustom ? `Search or type ${props.label.toLowerCase()}...` : 'Search...'}
              aria-label={`Search ${props.label}`}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && showCustom) select(customValue);
              }}
            />
          ) : null}
          {props.allowEmpty ? (
            <button
              type="button"
              className="block w-full rounded-sm px-2 py-1.5 text-left text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              role="option"
              aria-selected={!props.value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select('')}
            >
              Clear override
            </button>
          ) : null}
          {props.loading ? <p className="px-2 py-2 text-muted-foreground">Loading...</p> : null}
          {!props.loading && props.error ? <p className="px-2 py-2 text-destructive">{props.error}</p> : null}
          {!props.loading && !props.error && !filteredOptions.length && !showCustom ? (
            <p className="px-2 py-2 text-muted-foreground">No matches.</p>
          ) : null}
          {!props.loading && showCustom ? (
            <button
              type="button"
              className="block w-full rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
              role="option"
              aria-selected={false}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(customValue)}
            >
              Use "{customValue}"
            </button>
          ) : null}
          {!props.loading &&
            filteredOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={cn(
                  'block w-full rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-current',
                  option.value === props.value && 'bg-accent text-accent-foreground',
                )}
                disabled={option.available === false}
                role="option"
                aria-selected={option.value === props.value}
                title={option.available === false ? option.unavailableReason : option.label}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(option.value)}
              >
                <span className="block break-words leading-snug">{option.label}</span>
                {option.available === false ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {option.action
                      ? `${option.unavailableReason ?? 'Unavailable'} ${option.action}`
                      : (option.unavailableReason ?? 'Unavailable')}
                  </span>
                ) : null}
              </button>
            ))}
        </div>
      ) : null}
    </div>
  );
}
