import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { useAppNavigation } from './app-navigation.js';
import { loadInitialSelectedEnvironmentId, loadInitialSelectedEnvironmentRevisionId } from './app-helpers.js';

type TestNavigation = {
  selectedSkillId: string;
  selectedSkillRevisionId: string;
};

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

it('guards browser back and forward revision transitions and reverses declined traversal', async () => {
  window.history.replaceState({}, '', '/?skill=skill-1&revision=revision-1');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<NavigationHarness />);

  fireEvent.click(screen.getByRole('button', { name: 'Open revision 2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Make dirty' }));
  expect(screen.getByTestId('selection')).toHaveTextContent('skill-1/revision-2');

  window.history.back();
  await waitFor(() => expect(confirm).toHaveBeenCalledWith('Discard unsaved skill changes?'));
  await waitFor(() => expect(window.location.search).toBe('?skill=skill-1&revision=revision-2'));
  expect(screen.getByTestId('selection')).toHaveTextContent('skill-1/revision-2');

  confirm.mockReturnValue(true);
  window.history.back();
  await waitFor(() => expect(window.location.search).toBe('?skill=skill-1&revision=revision-1'));
  expect(screen.getByTestId('selection')).toHaveTextContent('skill-1/revision-1');

  confirm.mockReturnValue(false);
  fireEvent.click(screen.getByRole('button', { name: 'Make dirty' }));
  window.history.forward();
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(window.location.search).toBe('?skill=skill-1&revision=revision-1'));
  expect(screen.getByTestId('selection')).toHaveTextContent('skill-1/revision-1');
});

it('guards browser transitions between skills and restores the current skill when declined', async () => {
  window.history.replaceState({}, '', '/?skill=skill-1&revision=revision-1');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<NavigationHarness />);

  fireEvent.click(screen.getByRole('button', { name: 'Open skill 2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Make dirty' }));
  window.history.back();

  await waitFor(() => expect(confirm).toHaveBeenCalledWith('Discard unsaved skill changes?'));
  await waitFor(() => expect(window.location.search).toBe('?skill=skill-2'));
  expect(screen.getByTestId('selection')).toHaveTextContent('skill-2/');
});

it('loads environment revision deep links', () => {
  window.history.replaceState({}, '', '/?environment=environment-1&revision=revision-1');

  expect(loadInitialSelectedEnvironmentId()).toBe('environment-1');
  expect(loadInitialSelectedEnvironmentRevisionId()).toBe('revision-1');
});

it('tracks environment revisions in the URL and guards Back navigation when dirty', async () => {
  window.history.replaceState({}, '', '/?environment=environment-1');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<EnvironmentNavigationHarness />);

  fireEvent.click(screen.getByRole('button', { name: 'Open historical environment revision' }));
  expect(window.location.search).toBe('?environment=environment-1&revision=revision-1');
  expect(screen.getByTestId('environment-selection')).toHaveTextContent('environment-1/revision-1');

  fireEvent.click(screen.getByRole('button', { name: 'Make environment dirty' }));
  window.history.back();
  await waitFor(() => expect(confirm).toHaveBeenCalledWith('Discard unsaved environment changes?'));
  await waitFor(() => expect(window.location.search).toBe('?environment=environment-1&revision=revision-1'));

  confirm.mockReturnValue(true);
  window.history.back();
  await waitFor(() => expect(window.location.search).toBe('?environment=environment-1'));
  expect(screen.getByTestId('environment-selection')).toHaveTextContent('environment-1/');

  fireEvent.click(screen.getByRole('button', { name: 'Open environment 2' }));
  expect(window.location.search).toBe('?environment=environment-2');
  expect(screen.getByTestId('environment-selection')).toHaveTextContent('environment-2/');
});

function NavigationHarness() {
  const [navigation, setNavigation] = useState<TestNavigation>({
    selectedSkillId: 'skill-1',
    selectedSkillRevisionId: 'revision-1',
  });
  const [dirty, setDirty] = useState(false);
  const appNavigation = useAppNavigation({
    navigation,
    onNavigationChange: setNavigation,
    canNavigate: (next) => {
      if (
        next.selectedSkillId === navigation.selectedSkillId &&
        next.selectedSkillRevisionId === navigation.selectedSkillRevisionId
      )
        return true;
      if (!dirty) return true;
      if (!window.confirm('Discard unsaved skill changes?')) return false;
      setDirty(false);
      return true;
    },
  });

  return (
    <>
      <span data-testid="selection">
        {navigation.selectedSkillId}/{navigation.selectedSkillRevisionId}
      </span>
      <button type="button" onClick={() => setDirty(true)}>
        Make dirty
      </button>
      <button
        type="button"
        onClick={() =>
          appNavigation.navigate(
            { selectedSkillId: 'skill-1', selectedSkillRevisionId: 'revision-2' },
            { type: 'skill', id: 'skill-1', revisionId: 'revision-2' },
          )
        }
      >
        Open revision 2
      </button>
      <button
        type="button"
        onClick={() =>
          appNavigation.navigate(
            { selectedSkillId: 'skill-2', selectedSkillRevisionId: '' },
            { type: 'skill', id: 'skill-2' },
          )
        }
      >
        Open skill 2
      </button>
    </>
  );
}

function EnvironmentNavigationHarness() {
  const [navigation, setNavigation] = useState({
    sidebarPanel: 'environments',
    selectedEnvironmentId: 'environment-1',
    selectedEnvironmentRevisionId: '',
  });
  const [dirty, setDirty] = useState(false);
  const appNavigation = useAppNavigation({
    navigation,
    onNavigationChange: setNavigation,
    canNavigate: (next) => {
      if (
        next.selectedEnvironmentId === navigation.selectedEnvironmentId &&
        next.selectedEnvironmentRevisionId === navigation.selectedEnvironmentRevisionId
      )
        return true;
      if (!dirty) return true;
      if (!window.confirm('Discard unsaved environment changes?')) return false;
      setDirty(false);
      return true;
    },
  });

  return (
    <>
      <span data-testid="environment-selection">
        {navigation.selectedEnvironmentId}/{navigation.selectedEnvironmentRevisionId}
      </span>
      <button type="button" onClick={() => setDirty(true)}>
        Make environment dirty
      </button>
      <button
        type="button"
        onClick={() =>
          appNavigation.navigate(
            { ...navigation, selectedEnvironmentRevisionId: 'revision-1' },
            { type: 'environment', id: 'environment-1', revisionId: 'revision-1' },
          )
        }
      >
        Open historical environment revision
      </button>
      <button
        type="button"
        onClick={() =>
          appNavigation.navigate(
            { ...navigation, selectedEnvironmentId: 'environment-2', selectedEnvironmentRevisionId: '' },
            { type: 'environment', id: 'environment-2' },
          )
        }
      >
        Open environment 2
      </button>
    </>
  );
}
