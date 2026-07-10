// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { createRoutesStub } from 'react-router';
import PresetsPage, { loader } from '../app/presets/page';
import { storageKey } from '../lib/WorkspaceContext';
import type { Preset } from '../lib/api';

const mockGetMe        = vi.hoisted(() => vi.fn());
const mockGetPresets   = vi.hoisted(() => vi.fn());
const mockCreatePreset = vi.hoisted(() => vi.fn());
const mockDeletePreset = vi.hoisted(() => vi.fn());
const mockNavigate     = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getMe: mockGetMe,
  getPresets: mockGetPresets,
  createPreset: mockCreatePreset,
  deletePreset: mockDeletePreset,
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const TEAM_ID = 'team1';

// PresetsPage now fetches its data via a route loader instead of a mount-time
// useEffect — render it through a routes stub so useLoaderData() has the
// router context it needs.
function renderPresetsPage() {
  const Stub = createRoutesStub([{ path: '/presets', Component: PresetsPage, loader, HydrateFallback: () => null }]);
  return render(<Stub initialEntries={['/presets']} />);
}

const makePreset = (overrides: Partial<Preset> = {}): Preset => ({
  id: 'p1',
  name: 'API smoke test',
  description: 'Quick smoke check',
  type: 'backend',
  target_url: 'https://example.com',
  options: { vus: 5, duration: '30s' },
  thresholds: null,
  used_count: 3,
  created_at: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockGetMe.mockResolvedValue({ id: 'u1', email: 'a@example.com', role: 'member', teams: [], currentTeamId: TEAM_ID, orgs: [] });
  mockGetPresets.mockResolvedValue({ presets: [] });
});
afterEach(() => cleanup());

describe('PresetsPage — loading and empty state', () => {
  it('shows the empty state once loaded', async () => {
    renderPresetsPage();
    await waitFor(() => expect(screen.getByText(/No presets yet/)).toBeInTheDocument());
  });

  it('shows an error message when getPresets rejects', async () => {
    mockGetPresets.mockRejectedValue(new Error('network error'));
    renderPresetsPage();
    await waitFor(() => expect(screen.getByText(/Could not reach results-service/)).toBeInTheDocument());
  });
});

describe('PresetsPage — list rendering', () => {
  it('renders preset details for existing presets', async () => {
    mockGetPresets.mockResolvedValue({ presets: [makePreset()] });
    renderPresetsPage();
    await waitFor(() => expect(screen.getByText('API smoke test')).toBeInTheDocument());
    expect(screen.getByText('https://example.com')).toBeInTheDocument();
    expect(screen.getByText('backend')).toBeInTheDocument();
    expect(screen.getByText('used 3×')).toBeInTheDocument();
    expect(screen.getByText('Quick smoke check')).toBeInTheDocument();
    expect(screen.getByText('5 VUs')).toBeInTheDocument();
    expect(screen.getByText('30s')).toBeInTheDocument();
  });
});

describe('PresetsPage — create flow', () => {
  it('opens the form, fills required fields, and calls createPreset', async () => {
    mockCreatePreset.mockResolvedValue({ preset: makePreset() });
    renderPresetsPage();
    await waitFor(() => expect(screen.getByText(/No presets yet/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /new preset/i }));
    fireEvent.change(screen.getByPlaceholderText('API smoke test'), { target: { value: 'My preset' } });
    fireEvent.change(screen.getByPlaceholderText('https://example.com'), { target: { value: 'https://target.example.com' } });

    fireEvent.click(screen.getByRole('button', { name: /save preset/i }));

    await waitFor(() => expect(mockCreatePreset).toHaveBeenCalledWith(expect.objectContaining({
      name: 'My preset',
      target_url: 'https://target.example.com',
      type: 'backend',
      options: { vus: 5, duration: '30s' },
    })));
    await waitFor(() => expect(mockGetPresets).toHaveBeenCalledTimes(2));
  });

  it('shows a validation error when name is missing', async () => {
    renderPresetsPage();
    await waitFor(() => expect(screen.getByText(/No presets yet/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /new preset/i }));
    fireEvent.click(screen.getByRole('button', { name: /save preset/i }));

    await waitFor(() => expect(screen.getByText('Name is required')).toBeInTheDocument());
    expect(mockCreatePreset).not.toHaveBeenCalled();
  });

  it('shows an error message when createPreset fails', async () => {
    mockCreatePreset.mockRejectedValue(new Error('boom'));
    renderPresetsPage();
    await waitFor(() => expect(screen.getByText(/No presets yet/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /new preset/i }));
    fireEvent.change(screen.getByPlaceholderText('API smoke test'), { target: { value: 'My preset' } });
    fireEvent.click(screen.getByRole('button', { name: /save preset/i }));

    await waitFor(() => expect(screen.getByText('Failed to create preset')).toBeInTheDocument());
  });

  it('builds client-side options when type is client-side', async () => {
    mockCreatePreset.mockResolvedValue({ preset: makePreset({ type: 'client-side' }) });
    renderPresetsPage();
    await waitFor(() => expect(screen.getByText(/No presets yet/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /new preset/i }));
    fireEvent.change(screen.getByPlaceholderText('API smoke test'), { target: { value: 'Browser preset' } });
    const selects = screen.getAllByRole('combobox');
    const testTypeSelect = selects.find(el => (el as HTMLSelectElement).value === 'backend')!;
    fireEvent.change(testTypeSelect, { target: { value: 'client-side' } });

    fireEvent.click(screen.getByRole('button', { name: /save preset/i }));

    await waitFor(() => expect(mockCreatePreset).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Browser preset',
      type: 'client-side',
      options: { sessions: 2, duration: '30s', collectWebVitals: true },
    })));
  });
});

describe('PresetsPage — delete flow', () => {
  it('calls deletePreset when delete is confirmed', async () => {
    mockGetPresets.mockResolvedValue({ presets: [makePreset()] });
    mockDeletePreset.mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPresetsPage();
    await waitFor(() => expect(screen.getByText('API smoke test')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    await waitFor(() => expect(mockDeletePreset).toHaveBeenCalledWith('p1'));
  });

  it('does not call deletePreset when delete is cancelled', async () => {
    mockGetPresets.mockResolvedValue({ presets: [makePreset()] });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPresetsPage();
    await waitFor(() => expect(screen.getByText('API smoke test')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(mockDeletePreset).not.toHaveBeenCalled();
  });
});

// ─── Workspace filter ─────────────────────────────────────────────────────────
// The loader reads the active workspace straight from localStorage (the same
// place WorkspaceContext persists it) since loaders have no React context access.

describe('PresetsPage — workspace filter', () => {
  it('calls getPresets with null when no workspace is active', async () => {
    renderPresetsPage();
    await waitFor(() => expect(mockGetPresets).toHaveBeenCalled());
    expect(mockGetPresets).toHaveBeenCalledWith(null);
  });

  it('calls getPresets with active workspaceId when a workspace is selected', async () => {
    localStorage.setItem(storageKey(TEAM_ID), 'ws-xyz');
    renderPresetsPage();
    await waitFor(() => expect(mockGetPresets).toHaveBeenCalled());
    expect(mockGetPresets).toHaveBeenCalledWith('ws-xyz');
  });
});

describe('PresetsPage — Use button navigation', () => {
  it('navigates to / with query params built from the preset', async () => {
    mockGetPresets.mockResolvedValue({ presets: [makePreset()] });
    renderPresetsPage();
    await waitFor(() => expect(screen.getByText('API smoke test')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^use$/i }));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    const target = mockNavigate.mock.calls[0][0] as string;
    expect(target).toContain('/?');
    expect(target).toContain('type=backend');
    expect(target).toContain('targetUrl=https');
    expect(target).toContain('vus=5');
    expect(target).toContain('duration=30s');
  });
});
