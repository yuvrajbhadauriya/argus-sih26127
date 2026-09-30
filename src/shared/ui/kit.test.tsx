import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import { formatPlate, normalizePlate, vehicleClassToPlateVariant } from '@/shared/lib/plate';
import { formatIstTime, istHour } from '@/shared/lib/time';
import { PlateChip } from './PlateChip';
import { Modal } from './Modal';
import { DataTable, type Column } from './DataTable';
import { Tabs } from './Tabs';
import { SeverityChip, SEVERITY_ORDER } from './SeverityChip';
import { StatusPill } from './StatusPill';
import { Button, IconButton } from './Button';
import { Select } from './Input';
import { KpiTile } from './KpiTile';
import { VideoTile } from './VideoTile';
import { Toaster } from './Toaster';
import { toast, clearToasts } from './toast';
import { Panel } from './Card';

describe('plate helpers', () => {
  it.each([
    ['dl04rs9598', 'DL 04 RS 9598'],
    ['DL-04-RS-9598', 'DL 04 RS 9598'],
    ['dl4c1234', 'DL 04 C 1234'],
    ['22BH1234AA', '22 BH 1234 AA'],
    ['  weird plate ', 'WEIRD PLATE'],
  ])('formatPlate(%s) = %s', (raw, out) => {
    expect(formatPlate(raw)).toBe(out);
  });

  it('normalizePlate keeps uppercase alphanumerics only', () => {
    expect(normalizePlate('dl 04-rs.9598')).toBe('DL04RS9598');
  });

  it('maps trucks and buses to commercial plates', () => {
    expect(vehicleClassToPlateVariant('truck')).toBe('commercial');
    expect(vehicleClassToPlateVariant('Bus')).toBe('commercial');
    expect(vehicleClassToPlateVariant('car')).toBe('private');
  });
});

describe('IST time helpers', () => {
  it('formats in Asia/Kolkata regardless of local zone', () => {
    // 2026-09-30T00:00:00Z == 05:30:00 IST
    expect(formatIstTime(new Date('2026-09-30T00:00:00Z'))).toBe('05:30:00');
    expect(istHour('2026-09-30T20:00:00Z')).toBe(1);
  });
});

describe('PlateChip', () => {
  it('renders formatted text with an accessible label and flag', () => {
    render(<PlateChip plate="dl04rs9598" flag="watchlist" size="md" />);
    const chip = screen.getByRole('img', { name: 'Plate DL 04 RS 9598, watchlist' });
    expect(chip).toHaveTextContent('DL 04 RS 9598');
    expect(chip).toHaveTextContent('IND');
    expect(chip).toHaveAttribute('data-flag', 'watchlist');
  });

  it('renders a button when clickable and a link when `to` is set', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<PlateChip plate="DL04RS9598" onClick={onClick} />);
    await userEvent.click(screen.getByRole('button', { name: 'Plate DL 04 RS 9598' }));
    expect(onClick).toHaveBeenCalledOnce();
    rerender(
      <MemoryRouter>
        <PlateChip plate="DL04RS9598" to="/vehicles?plate=DL04RS9598" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Plate DL 04 RS 9598' })).toHaveAttribute('href', '/vehicles?plate=DL04RS9598');
  });
});

describe('Modal', () => {
  function Harness({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        <Modal
          open={open}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          title="Register camera"
          footer={<Button>Save</Button>}
        >
          <input aria-label="Name" />
        </Modal>
      </>
    );
  }

  it('is a labelled dialog, focuses inside, closes on Esc and restores focus', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Register camera' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on scrim click and traps Tab focus', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog');
    const focusables = within(dialog).getAllByRole('button').concat(within(dialog).getAllByRole('textbox'));
    expect(focusables.length).toBe(3);
    for (let i = 0; i < 5; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.click(screen.getByTestId('modal-scrim'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('DataTable', () => {
  type Row = { id: string; plate: string; conf: number };
  const rows: Row[] = [
    { id: 'a', plate: 'B', conf: 0.5 },
    { id: 'b', plate: 'A', conf: 0.9 },
    { id: 'c', plate: 'C', conf: 0.7 },
  ];
  const columns: Column<Row>[] = [
    { key: 'plate', header: 'Plate', cell: (r) => r.plate, sortValue: (r) => r.plate },
    { key: 'conf', header: 'Conf', cell: (r) => r.conf, sortValue: (r) => r.conf, align: 'right' },
  ];
  const bodyText = () =>
    screen
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.textContent);

  it('sorts via header buttons and exposes aria-sort', async () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(bodyText()).toEqual(['B0.5', 'A0.9', 'C0.7']);
    await userEvent.click(screen.getByRole('button', { name: /Plate/ }));
    expect(bodyText()).toEqual(['A0.9', 'B0.5', 'C0.7']);
    expect(screen.getByRole('columnheader', { name: /Plate/ })).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(screen.getByRole('button', { name: /Plate/ }));
    expect(bodyText()).toEqual(['C0.7', 'B0.5', 'A0.9']);
  });

  it('paginates, activates rows with Enter and marks selection/tone', async () => {
    const onRowClick = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        pageSize={2}
        onRowClick={onRowClick}
        selectedKey="b"
        rowTone={(r) => (r.conf < 0.6 ? 'danger' : null)}
      />,
    );
    expect(screen.getByText('1–2 of 3')).toBeInTheDocument();
    const rowsEls = screen.getAllByRole('row').slice(1);
    expect(rowsEls[0]).toHaveAttribute('data-tone', 'danger');
    expect(rowsEls[1]).toHaveAttribute('data-selected', 'true');
    rowsEls[0].focus();
    await userEvent.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(bodyText()).toEqual(['C0.7']);
  });

  it('renders the empty slot and loading skeleton', () => {
    const { rerender } = render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} empty={<p>Nothing here</p>} />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    rerender(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} loading />);
    expect(screen.getAllByRole('row')).toHaveLength(9);
  });
});

describe('Tabs', () => {
  it('uses tab roles and arrow-key roving focus', async () => {
    function T() {
      const [v, setV] = useState('a');
      return (
        <Tabs
          ariaLabel="Sections"
          value={v}
          onChange={setV}
          items={[
            { id: 'a', label: 'Overview' },
            { id: 'b', label: 'Speed', count: 3 },
          ]}
        />
      );
    }
    render(<T />);
    const first = screen.getByRole('tab', { name: 'Overview' });
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveAttribute('aria-controls', 'panel-a');
    first.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /Speed/ })).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Speed/ }));
  });
});

describe('chips, pills and buttons', () => {
  it('SeverityChip exposes data-severity and SEVERITY_ORDER sorts critical first', () => {
    render(<SeverityChip severity="high" />);
    expect(screen.getByText('High').closest('[data-severity]')).toHaveAttribute('data-severity', 'high');
    expect(['low', 'critical', 'medium'].sort((a, b) => SEVERITY_ORDER[a as 'low'] - SEVERITY_ORDER[b as 'low'])).toEqual(['critical', 'medium', 'low']);
  });

  it('StatusPill renders data-status and default label', () => {
    render(<StatusPill status="degraded" />);
    expect(screen.getByText('Degraded')).toHaveAttribute('data-status', 'degraded');
  });

  it('Button loading disables and sets aria-busy; IconButton is labelled', () => {
    render(
      <>
        <Button loading>Save</Button>
        <IconButton label="Refresh" icon={<span>R</span>} badge={3} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute('title', 'Refresh');
  });

  it('Select stays a native combobox', async () => {
    render(
      <Select label="Zone" defaultValue="all">
        <option value="all">All</option>
        <option value="north">North</option>
      </Select>,
    );
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Zone' }), 'north');
    expect(screen.getByRole('combobox')).toHaveValue('north');
  });

  it('KpiTile shows value, unit and a delta', () => {
    render(<KpiTile label="Avg speed" value={32} unit="km/h" delta={{ value: '+4%', direction: 'up', good: true }} />);
    expect(screen.getByText('32')).toBeInTheDocument();
    expect(screen.getByText('km/h')).toBeInTheDocument();
    expect(screen.getByText('+4%')).toHaveClass('text-success');
  });

  it('Panel renders header, body and footer', () => {
    render(
      <Panel title="AI Detection" subtitle="YOLOv7-tiny" footer="foot">
        body
      </Panel>,
    );
    expect(screen.getByRole('heading', { name: 'AI Detection' })).toBeInTheDocument();
    expect(screen.getByText('foot')).toBeInTheDocument();
  });
});

describe('VideoTile', () => {
  it('shows the offline state with a Retry button that does not select the tile', async () => {
    const onRetry = vi.fn();
    const onSelect = vi.fn();
    render(<VideoTile code="IG-01" name="India Gate" status="offline" onRetry={onRetry} onSelect={onSelect} />);
    expect(screen.getByText('Feed offline')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Open feed IG-01 India Gate' }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('shows LIVE for live feeds', () => {
    render(<VideoTile code="IG-01" name="India Gate" status="live" />);
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });
});

describe('toast', () => {
  afterEach(() => clearToasts());

  it('shows toasts (max 3), danger as alert, and auto-dismisses', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      toast({ title: 'One', tone: 'success' });
      toast({ title: 'Two' });
      toast({ title: 'Three' });
      toast({ title: 'Failed', tone: 'danger', durationMs: 1000 });
    });
    expect(screen.queryByText('One')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed');
    act(() => {
      vi.advanceTimersByTime(1001);
    });
    expect(screen.queryByText('Failed')).toBeNull();
    vi.useRealTimers();
  });
});
