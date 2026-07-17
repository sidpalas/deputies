import { fireEvent, render, screen } from '@testing-library/react';
import { RevisionSelector } from './components/app-panels/revision-selector.js';

it('orders revisions newest-first in a bounded scrollable picker and maps current to edit mode', () => {
  const onSelectRevision = vi.fn();
  const revisions = Array.from({ length: 20 }, (_, index) => ({
    id: `revision-${index + 1}`,
    revisionNumber: index + 1,
    createdAt: `2026-07-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
  }));
  render(
    <RevisionSelector
      currentRevisionId="revision-20"
      currentRevisionNumber={20}
      selectedRevisionId=""
      revisions={revisions}
      loading={false}
      onSelectRevision={onSelectRevision}
    />,
  );

  const trigger = screen.getByLabelText('Revision');
  expect(trigger).toHaveTextContent('Revision 20');
  expect(trigger).toHaveClass('h-8', 'w-auto', 'text-xs');
  fireEvent.click(trigger);
  const list = screen.getByRole('listbox');
  expect(list).toHaveClass('overflow-auto', 'max-h-80');
  expect(screen.getAllByRole('option')[0]).toHaveTextContent(/Revision 20.*Current/);
  expect(screen.getAllByRole('option')[19]).toHaveTextContent(/Revision 1.*Historical/);

  fireEvent.click(screen.getByTitle('Revision 1'));
  expect(onSelectRevision).toHaveBeenLastCalledWith('revision-1');

  fireEvent.click(screen.getByLabelText('Revision'));
  fireEvent.click(screen.getByTitle('Revision 20'));
  expect(onSelectRevision).toHaveBeenLastCalledWith('');
});
