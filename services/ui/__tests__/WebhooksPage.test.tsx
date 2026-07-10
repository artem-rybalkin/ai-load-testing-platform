// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { createRoutesStub } from 'react-router';
import WebhooksPage, { loader } from '../app/webhooks/page';
import { storageKey } from '../lib/WorkspaceContext';
import type { Webhook, LogSource } from '../lib/api';

const mockGetMe              = vi.hoisted(() => vi.fn());
const mockGetWebhooks        = vi.hoisted(() => vi.fn());
const mockCreateWebhook      = vi.hoisted(() => vi.fn());
const mockDeleteWebhook      = vi.hoisted(() => vi.fn());
const mockGetLogSources      = vi.hoisted(() => vi.fn());
const mockCreateLogSource    = vi.hoisted(() => vi.fn());
const mockUpdateLogSource    = vi.hoisted(() => vi.fn());
const mockDeleteLogSource    = vi.hoisted(() => vi.fn());
const mockPredictWebhookNoise = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getMe: mockGetMe,
  getWebhooks: mockGetWebhooks,
  createWebhook: mockCreateWebhook,
  deleteWebhook: mockDeleteWebhook,
  getLogSources: mockGetLogSources,
  createLogSource: mockCreateLogSource,
  updateLogSource: mockUpdateLogSource,
  deleteLogSource: mockDeleteLogSource,
  predictWebhookNoise: mockPredictWebhookNoise,
}));

const mockActiveWorkspaceId = vi.hoisted(() => ({ current: null as string | null }));

// Only useWorkspace() is mocked (still used by the component for the
// create-time workspaceId) — storageKey stays the real implementation so the
// loader (which reads localStorage directly, no context access) works as-is.
vi.mock('@/lib/WorkspaceContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/WorkspaceContext')>();
  return { ...actual, useWorkspace: () => ({ workspaces: [], activeWorkspaceId: mockActiveWorkspaceId.current, setActiveWorkspaceId: vi.fn(), refetch: vi.fn() }) };
});

const TEAM_ID = 'team1';

// WebhooksPage now fetches its webhooks via a route loader instead of a
// mount-time useEffect — render it through a routes stub so useLoaderData()
// has the router context it needs. (LogSourcesSection is not workspace-scoped
// and keeps its own mount-time fetch, untouched by this migration.)
function renderWebhooksPage() {
  const Stub = createRoutesStub([{ path: '/webhooks', Component: WebhooksPage, loader, HydrateFallback: () => null }]);
  return render(<Stub initialEntries={['/webhooks']} />);
}

const makeWebhook = (overrides: Partial<Webhook> = {}): Webhook => ({
  id: 'wh1',
  url: 'https://hooks.example.com/notify',
  events: ['failed', 'degraded'],
  format: 'generic',
  created_at: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

const makeLogSource = (overrides: Partial<LogSource> = {}): LogSource => ({
  id: 'ls1',
  name: 'Production Grafana',
  platform: 'Grafana',
  url_template: 'https://grafana.example.com/explore?from={startedAtMs}&to={completedAtMs}',
  metrics_endpoint_template: null,
  auth_header: null,
  created_at: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockActiveWorkspaceId.current = null;
  mockGetMe.mockResolvedValue({ id: 'u1', email: 'a@example.com', role: 'member', teams: [], currentTeamId: TEAM_ID, orgs: [] });
  mockGetWebhooks.mockResolvedValue({ webhooks: [] });
  mockGetLogSources.mockResolvedValue({ logSources: [] });
  mockPredictWebhookNoise.mockResolvedValue({ level: 'ok', warning: null, message: '' });
});
afterEach(() => cleanup());

describe('WebhooksPage — initial load', () => {
  it('renders empty states for both sections', async () => {
    renderWebhooksPage();
    await waitFor(() => expect(screen.getByText('No webhooks configured')).toBeInTheDocument());
    expect(screen.getByText('No log sources configured')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Webhooks', level: 1 })).toBeInTheDocument();
  });

  it('shows an error message when getWebhooks rejects', async () => {
    mockGetWebhooks.mockRejectedValue(new Error('network error'));
    renderWebhooksPage();
    await waitFor(() => expect(screen.getByText(/Could not reach results-service/)).toBeInTheDocument());
  });

  it('renders existing webhooks and log sources', async () => {
    mockGetWebhooks.mockResolvedValue({ webhooks: [makeWebhook()] });
    mockGetLogSources.mockResolvedValue({ logSources: [makeLogSource()] });
    renderWebhooksPage();

    await waitFor(() => expect(screen.getByText('https://hooks.example.com/notify')).toBeInTheDocument());
    expect(screen.getByText(/Events: failed, degraded/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Production Grafana')).toBeInTheDocument());
    expect(screen.getAllByText('Grafana').length).toBeGreaterThan(0);
  });
});

describe('WebhooksPage — webhook create flow', () => {
  it('shows a validation error when URL is empty', async () => {
    renderWebhooksPage();
    await waitFor(() => expect(screen.getByText('No webhooks configured')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /add webhook/i }));
    await waitFor(() => expect(screen.getByText('URL is required')).toBeInTheDocument());
    expect(mockCreateWebhook).not.toHaveBeenCalled();
  });

  it('calls createWebhook with url, events, and format', async () => {
    mockCreateWebhook.mockResolvedValue({ webhook: makeWebhook() });
    renderWebhooksPage();
    await waitFor(() => expect(screen.getByText('No webhooks configured')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('https://your-endpoint.example.com/webhook'), {
      target: { value: 'https://my-hook.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add webhook/i }));

    await waitFor(() => expect(mockCreateWebhook).toHaveBeenCalledWith(
      'https://my-hook.example.com', ['failed', 'degraded'], 'generic', undefined
    ));
    await waitFor(() => expect(mockGetWebhooks).toHaveBeenCalledTimes(2));
  });

  it('shows an error message when createWebhook fails', async () => {
    mockCreateWebhook.mockRejectedValue(new Error('boom'));
    renderWebhooksPage();
    await waitFor(() => expect(screen.getByText('No webhooks configured')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('https://your-endpoint.example.com/webhook'), {
      target: { value: 'https://my-hook.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add webhook/i }));

    await waitFor(() => expect(screen.getByText('Failed to save webhook')).toBeInTheDocument());
  });

  it('toggles the "degraded" event off and checks noise prediction', async () => {
    mockPredictWebhookNoise.mockResolvedValue({ level: 'noisy', warning: true, message: 'Too many alerts' });
    renderWebhooksPage();
    await waitFor(() => expect(screen.getByText('No webhooks configured')).toBeInTheDocument());

    const degradedCheckbox = screen.getByRole('checkbox', { name: /degraded/i });
    fireEvent.click(degradedCheckbox);

    await waitFor(() => expect(mockPredictWebhookNoise).toHaveBeenCalledWith(['failed']));
    expect(await screen.findByText(/Too many alerts/)).toBeInTheDocument();
  });
});

describe('WebhooksPage — webhook delete flow', () => {
  it('calls deleteWebhook and reloads the list', async () => {
    mockGetWebhooks.mockResolvedValue({ webhooks: [makeWebhook()] });
    mockDeleteWebhook.mockResolvedValue(undefined);
    renderWebhooksPage();

    await waitFor(() => expect(screen.getByText('https://hooks.example.com/notify')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));

    await waitFor(() => expect(mockDeleteWebhook).toHaveBeenCalledWith('wh1'));
  });
});

describe('WebhooksPage — log source create flow', () => {
  it('shows a validation error when required fields are missing', async () => {
    renderWebhooksPage();
    await waitFor(() => expect(screen.getByText('No log sources configured')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /add log source/i }));
    await waitFor(() => expect(screen.getByText('Name and URL template are required')).toBeInTheDocument());
    expect(mockCreateLogSource).not.toHaveBeenCalled();
  });

  it('calls createLogSource with name, platform and urlTemplate', async () => {
    mockCreateLogSource.mockResolvedValue({ logSource: makeLogSource() });
    renderWebhooksPage();
    await waitFor(() => expect(screen.getByText('No log sources configured')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('e.g. Production Grafana'), { target: { value: 'My Grafana' } });
    fireEvent.change(screen.getByPlaceholderText(/grafana.example.com\/explore/), { target: { value: 'https://g.example.com?from={startedAtMs}' } });
    fireEvent.click(screen.getByRole('button', { name: /add log source/i }));

    await waitFor(() => expect(mockCreateLogSource).toHaveBeenCalledWith(expect.objectContaining({
      name: 'My Grafana',
      platform: 'Grafana',
      urlTemplate: 'https://g.example.com?from={startedAtMs}',
    })));
    await waitFor(() => expect(mockGetLogSources).toHaveBeenCalledTimes(2));
  });

  it('shows an error message when createLogSource fails', async () => {
    mockCreateLogSource.mockRejectedValue(new Error('boom'));
    renderWebhooksPage();
    await waitFor(() => expect(screen.getByText('No log sources configured')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('e.g. Production Grafana'), { target: { value: 'My Grafana' } });
    fireEvent.change(screen.getByPlaceholderText(/grafana.example.com\/explore/), { target: { value: 'https://g.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /add log source/i }));

    await waitFor(() => expect(screen.getByText('Failed to save log source')).toBeInTheDocument());
  });
});

describe('WebhooksPage — log source edit and delete flow', () => {
  it('loads a source into the form for editing and saves changes', async () => {
    mockGetLogSources.mockResolvedValue({ logSources: [makeLogSource()] });
    mockUpdateLogSource.mockResolvedValue({ logSource: makeLogSource({ name: 'Updated Grafana' }) });
    renderWebhooksPage();

    await waitFor(() => expect(screen.getByText('Production Grafana')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));

    const nameInput = screen.getByPlaceholderText('e.g. Production Grafana') as HTMLInputElement;
    expect(nameInput.value).toBe('Production Grafana');

    fireEvent.change(nameInput, { target: { value: 'Updated Grafana' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockUpdateLogSource).toHaveBeenCalledWith('ls1', expect.objectContaining({ name: 'Updated Grafana' })));
  });

  it('calls deleteLogSource and reloads the list', async () => {
    mockGetLogSources.mockResolvedValue({ logSources: [makeLogSource()] });
    mockDeleteLogSource.mockResolvedValue(undefined);
    renderWebhooksPage();

    await waitFor(() => expect(screen.getByText('Production Grafana')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));

    await waitFor(() => expect(mockDeleteLogSource).toHaveBeenCalledWith('ls1'));
    await waitFor(() => expect(mockGetLogSources).toHaveBeenCalledTimes(2));
  });
});

// ─── Workspace filter ─────────────────────────────────────────────────────────
// The loader reads the active workspace straight from localStorage (the same
// place WorkspaceContext persists it) since loaders have no React context access.

describe('WebhooksPage — workspace filter', () => {
  it('calls getWebhooks with null when no workspace is active', async () => {
    renderWebhooksPage();
    await waitFor(() => expect(mockGetWebhooks).toHaveBeenCalled());
    expect(mockGetWebhooks).toHaveBeenCalledWith(null);
  });

  it('calls getWebhooks with active workspaceId when a workspace is selected', async () => {
    localStorage.setItem(storageKey(TEAM_ID), 'ws-hook');
    renderWebhooksPage();
    await waitFor(() => expect(mockGetWebhooks).toHaveBeenCalled());
    expect(mockGetWebhooks).toHaveBeenCalledWith('ws-hook');
  });

  it('passes workspaceId to createWebhook when creating a webhook in an active workspace', async () => {
    mockActiveWorkspaceId.current = 'ws-hook-create';
    mockCreateWebhook.mockResolvedValue({ webhook: makeWebhook() });
    renderWebhooksPage();
    await waitFor(() => expect(screen.getByText('No webhooks configured')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('https://your-endpoint.example.com/webhook'), {
      target: { value: 'https://hook.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add webhook/i }));

    await waitFor(() => expect(mockCreateWebhook).toHaveBeenCalledWith(
      'https://hook.example.com', ['failed', 'degraded'], 'generic', 'ws-hook-create'
    ));
  });
});
