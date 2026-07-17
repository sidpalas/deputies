import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { SkillsSidebar } from './components/app-panels/skills-sidebar.js';
import type { NavigationPage } from './components/app-panels/sidebar-footer.js';

it('shows Setup in the shared page switcher when setup is opened from Skills', () => {
  render(<SkillsNavigationHarness />);

  fireEvent.click(screen.getByRole('button', { name: 'Switch page, current page Skills' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Setup/ }));

  expect(screen.getByRole('button', { name: 'Switch page, current page Setup' })).toBeInTheDocument();
});

function SkillsNavigationHarness() {
  const [navPage, setNavPage] = useState<NavigationPage>('skills');
  return (
    <SkillsSidebar
      canCallApi
      canCreateSkills
      footerProps={{
        authRequired: false,
        canViewGroups: true,
        canViewAutomations: true,
        canViewEnvironments: true,
        canViewSkills: true,
        canViewSetup: true,
        health: null,
        navPage,
        themePreference: 'system',
        token: '',
        onOpenAutomations: () => setNavPage('automations'),
        onOpenEnvironments: () => setNavPage('environments'),
        onOpenGroups: () => setNavPage('groups'),
        onOpenSessions: () => setNavPage('sessions'),
        onOpenSetup: () => setNavPage('setup'),
        onOpenSkills: () => setNavPage('skills'),
        onSignOut: () => undefined,
        onThemeChange: () => undefined,
      }}
      groups={[]}
      loading={false}
      skills={[]}
      selectedSkillId=""
      onBackToSessions={() => undefined}
      onArchiveSkill={() => undefined}
      onCollapse={() => undefined}
      onCreateSkill={() => undefined}
      onRestoreSkill={() => undefined}
      onSelectSkill={() => undefined}
    />
  );
}
