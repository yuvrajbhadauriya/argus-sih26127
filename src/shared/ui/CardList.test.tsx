import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CardList } from './CardList';
import { DataTable, type Column } from './DataTable';

interface Row {
  id: string;
  plate: string;
}
const rows: Row[] = [
  { id: 'a', plate: 'MH 01 AA 0001' },
  { id: 'b', plate: 'MH 02 BB 0002' },
];

describe('CardList', () => {
  it('renders one card per row; the body is the only button when actions are separate', async () => {
    const onRowClick = vi.fn();
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(
      <CardList
        label="Reads"
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={onRowClick}
        selectedKey="b"
        rowTone={(r) => (r.id === 'a' ? 'danger' : null)}
        render={(r) => ({
          body: <span>{r.plate}</span>,
          actions: <button type="button" aria-label={`Trace ${r.plate}`} onClick={onAction} />,
        })}
      />,
    );
    const items = within(screen.getByRole('list', { name: 'Reads' })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('data-tone', 'danger');
    expect(items[1]).toHaveAttribute('data-selected', 'true');
    await user.click(screen.getByRole('button', { name: 'MH 01 AA 0001' }));
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
    await user.click(screen.getByRole('button', { name: 'Trace MH 02 BB 0002' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it('is not a button when rows are not actionable', () => {
    render(<CardList rows={rows} rowKey={(r) => r.id} render={(r) => ({ body: <span>{r.plate}</span> })} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('DataTable on phones', () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });
  const columns: Column<Row>[] = [{ key: 'plate', header: 'Plate', cell: (r) => r.plate }];
  const stubPhone = (matches: boolean) => {
    window.matchMedia = ((q: string) => ({
      matches: matches && q.includes('max-width: 767px'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  };

  it('renders cards instead of a table below 768px when renderCard is given', () => {
    stubPhone(true);
    render(<DataTable caption="Reads" columns={columns} rows={rows} rowKey={(r) => r.id} renderCard={(r) => ({ body: r.plate })} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('keeps the table on wider screens and without renderCard', () => {
    stubPhone(false);
    const { unmount } = render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} renderCard={(r) => ({ body: r.plate })} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    unmount();
    stubPhone(true);
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});
