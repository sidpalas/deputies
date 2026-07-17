import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  BookOpenCheck,
  Check,
  ChevronsUpDown,
  KeyRound,
  Layers3,
  LogOut,
  MessagesSquare,
  Monitor,
  Moon,
  Settings2,
  Sun,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import type { Health } from '../../api.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import type { ThemePreference } from './types.js';

export type NavigationPage = 'sessions' | 'setup' | 'groups' | 'automations' | 'environments' | 'skills';

const navigationPages: Array<{
  id: NavigationPage;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  { id: 'sessions', label: 'Sessions', description: 'Run and review agent work', icon: MessagesSquare },
  { id: 'automations', label: 'Automations', description: 'Schedule recurring work', icon: Bot },
  { id: 'skills', label: 'Skills', description: 'Manage reusable agent instructions', icon: BookOpenCheck },
  { id: 'groups', label: 'Access', description: 'Manage groups and permissions', icon: UsersRound },
  { id: 'environments', label: 'Environments', description: 'Configure execution environments', icon: Layers3 },
  { id: 'setup', label: 'Setup', description: 'Review deployment configuration', icon: Settings2 },
];

const themeOptions: Array<{ value: ThemePreference; label: string; icon: LucideIcon }> = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

export type SidebarFooterProps = {
  authRequired: boolean;
  canViewGroups: boolean;
  canViewAutomations: boolean;
  canViewEnvironments: boolean;
  canViewSkills: boolean;
  canViewSetup: boolean;
  health: Health | null;
  navPage: NavigationPage;
  themePreference: ThemePreference;
  token: string;
  onOpenGroups: () => void;
  onOpenAutomations: () => void;
  onOpenEnvironments: () => void;
  onOpenSkills: () => void;
  onOpenSessions: () => void;
  onOpenSetup: () => void;
  onSignOut: () => void;
  onThemeChange: (value: ThemePreference) => void;
};

export function SidebarFooter(props: SidebarFooterProps) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationRef = useRef<HTMLDivElement>(null);
  const currentPage = navigationPages.find((page) => page.id === props.navPage) ?? navigationPages[0]!;
  const CurrentPageIcon = currentPage.icon;
  const theme = themeOptions.find((option) => option.value === props.themePreference) ?? themeOptions[0]!;
  const ThemeIcon = theme.icon;
  const showSignOut = props.authRequired && (props.token || props.health?.apiAuthMode === 'session');
  const visiblePages = navigationPages.filter((page) => {
    if (page.id === 'groups') return props.canViewGroups;
    if (page.id === 'automations') return props.canViewAutomations;
    if (page.id === 'skills') return props.canViewSkills;
    if (page.id === 'environments') return props.canViewEnvironments;
    if (page.id === 'setup') return props.canViewSetup;
    return true;
  });

  useEffect(() => {
    if (!navigationOpen) return;

    function closeOnOutsideClick(event: MouseEvent) {
      if (event.target instanceof Node && navigationRef.current?.contains(event.target)) return;
      setNavigationOpen(false);
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setNavigationOpen(false);
      navigationRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus();
    }

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [navigationOpen]);

  const pageActions: Record<NavigationPage, () => void> = {
    sessions: props.onOpenSessions,
    automations: props.onOpenAutomations,
    skills: props.onOpenSkills,
    groups: props.onOpenGroups,
    environments: props.onOpenEnvironments,
    setup: props.onOpenSetup,
  };

  function navigate(page: NavigationPage) {
    setNavigationOpen(false);
    pageActions[page]();
  }

  function cycleTheme() {
    const currentIndex = themeOptions.findIndex((option) => option.value === props.themePreference);
    const nextTheme = themeOptions[(currentIndex + 1) % themeOptions.length] ?? themeOptions[0]!;
    props.onThemeChange(nextTheme.value);
  }

  return (
    <div
      className="relative mt-3 flex shrink-0 gap-2 border-t border-border pt-3 text-left"
      ref={navigationRef}
      aria-label="Sidebar navigation"
    >
      {navigationOpen ? (
        <div
          className="absolute bottom-[calc(100%+0.5rem)] left-0 z-50 max-h-[min(26rem,calc(100dvh-8rem))] w-full overflow-y-auto rounded-lg border border-border bg-card p-1.5 text-card-foreground shadow-xl"
          role="menu"
          aria-label="Pages"
        >
          <p className="px-2 pb-1 pt-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Go to
          </p>
          {visiblePages.map((page) => {
            const Icon = page.icon;
            const active = page.id === props.navPage;
            return (
              <button
                key={page.id}
                type="button"
                className={cn(
                  'group flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active && 'bg-primary/10 text-foreground',
                )}
                role="menuitem"
                aria-current={active ? 'page' : undefined}
                onClick={() => navigate(page.id)}
              >
                <span
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground',
                    active && 'border-primary/40 bg-primary/15 text-primary',
                  )}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium leading-tight">{page.label}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">{page.description}</span>
                </span>
                {active ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <Button
        className="min-w-0 flex-1 justify-start bg-card px-2.5 text-foreground shadow-sm"
        variant="secondary"
        size="sm"
        aria-expanded={navigationOpen}
        aria-haspopup="menu"
        aria-label={`Switch page, current page ${currentPage.label}`}
        onClick={() => setNavigationOpen((open) => !open)}
      >
        <CurrentPageIcon className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-left">{currentPage.label}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </Button>
      {showSignOut ? (
        <Button
          className="h-8 w-8 shrink-0"
          variant="secondary"
          size="icon"
          onClick={props.onSignOut}
          aria-label={props.health?.apiAuthMode === 'session' ? 'Sign out' : 'Clear token'}
          title={props.health?.apiAuthMode === 'session' ? 'Sign out' : 'Clear token'}
        >
          {props.health?.apiAuthMode === 'session' ? <LogOut className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
        </Button>
      ) : null}
      <Button
        className="h-8 w-8 shrink-0"
        variant="secondary"
        size="icon"
        onClick={cycleTheme}
        aria-label={`Theme: ${theme.label}. Change theme`}
        title={`Theme: ${theme.label}. Click to change.`}
      >
        <ThemeIcon className="h-4 w-4" />
      </Button>
    </div>
  );
}
