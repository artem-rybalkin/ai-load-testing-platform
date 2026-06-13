// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import SchedulesPage from '../app/schedules/page';
import type { Schedule } from '../lib/api';

const mockGetSchedules    = vi.hoisted(() => vi.fn());
const mockCreateSchedule  = vi.hoisted(() => vi.fn());
const mockUpdateSchedule  = vi.hoisted(() => vi.fn());
const mockDeleteSchedule  = vi.hoisted(() => vi.fn());
const mockRunSchedule     = vi.hoisted(() => vi.fn());
const mockConvertCron     = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getSchedules: mockGetSchedules,
  createSchedule: mockCreateSchedule,
  updateSchedule: mockUpdateSchedule,
  deleteSchedule: mockDeleteSchedule,
  runSchedule: mockRunSchedule,
  convertCron: mockConvertCron,
}));

const makeSchedule = (overrides: Partial<Schedule> = {}): Schedule => ({
  id: 's1',
  name: 'Hourly smoke test',
  cron: '0 * * * *',
  type: 'backend',
  target_url: 'https://example.com',
  description: null,
  options: { vus: 5, duration: '30s' },
  thresholds: null,
  enabled: true,
  last_run_at: null,
  created_at: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSchedules.mockResolvedValue({ schedules: [] });
});
afterEach(() => cleanup());

describe('SchedulesPage — loading and empty state', () => {
  it('shows loading then empty state when no schedules exist', async () => {
    render(<SchedulesPage />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/No schedules yet/)).toBeInTheDocument());
  });

  it('shows an error message when getSchedules rejects', async () => {
    mockGetSchedules.mockRejectedValue(new Error('network error'));
    render(<SchedulesPage />);
    await waitFor(() => expect(screen.getByText(/Could not reach results-service/)).toBeInTheDocument());
  });
});

describe('SchedulesPage — list rendering', () => {
  it('renders schedule details for existing schedules', async () => {
    mockGetSchedules.mockResolvedValue({ schedules: [makeSchedule()] });
    render(<SchedulesPage />);
    await waitFor(() => expect(screen.getByText('Hourly smoke test')).toBeInTheDocument());
    expect(screen.getByText('https://example.com')).toBeInTheDocument();
    expect(screen.getByText('0 * * * *')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('shows "paused" badge for disabled schedules', async () => {
    mockGetSchedules.mockResolvedValue({ schedules: [makeSchedule({ enabled: false })] });
    render(<SchedulesPage />);
    await waitFor(() => expect(screen.getByText('paused')).toBeInTheDocument());
  });
});

describe('SchedulesPage — create flow', () => {
  it('opens the form, fills required fields, and calls createSchedule', async () => {
    mockCreateSchedule.mockResolvedValue({ schedule: makeSchedule() });
    render(<SchedulesPage />);
    await waitFor(() => expect(screen.getByText(/No schedules yet/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /new schedule/i }));
    fireEvent.change(screen.getByPlaceholderText('Hourly smoke test'), { target: { value: 'My schedule' } });
    fireEvent.change(screen.getByPlaceholderText('https://example.com'), { target: { value: 'https://target.example.com' } });

    fireEvent.click(screen.getByRole('button', { name: /create schedule/i }));

    await waitFor(() => expect(mockCreateSchedule).toHaveBeenCalledWith(expect.objectContaining({
      name: 'My schedule',
      target_url: 'https://target.example.com',
      type: 'backend',
      options: { vus: 5, duration: '30s' },
      enabled: true,
    })));
    expect(mockGetSchedules).toHaveBeenCalledTimes(2);
  });

  it('shows a validation error when required fields are missing', async () => {
    render(<SchedulesPage />);
    await waitFor(() => expect(screen.getByText(/No schedules yet/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /new schedule/i }));
    fireEvent.click(screen.getByRole('button', { name: /create schedule/i }));

    await waitFor(() => expect(screen.getByText(/Name, URL and cron are required/)).toBeInTheDocument());
    expect(mockCreateSchedule).not.toHaveBeenCalled();
  });

  it('shows an error message when createSchedule fails', async () => {
    mockCreateSchedule.mockRejectedValue(new Error('boom'));
    render(<SchedulesPage />);
    await waitFor(() => expect(screen.getByText(/No schedules yet/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /new schedule/i }));
    fireEvent.change(screen.getByPlaceholderText('Hourly smoke test'), { target: { value: 'My schedule' } });
    fireEvent.change(screen.getByPlaceholderText('https://example.com'), { target: { value: 'https://target.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /create schedule/i }));

    await waitFor(() => expect(screen.getByText(/Failed to create schedule/)).toBeInTheDocument());
  });
});

describe('SchedulesPage — actions on existing schedules', () => {
  it('calls runSchedule when "Run now" is clicked', async () => {
    mockGetSchedules.mockResolvedValue({ schedules: [makeSchedule()] });
    mockRunSchedule.mockResolvedValue(undefined);
    render(<SchedulesPage />);
    await waitFor(() => expect(screen.getByText('Hourly smoke test')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /run now/i }));
    await waitFor(() => expect(mockRunSchedule).toHaveBeenCalledWith('s1'));
  });

  it('calls updateSchedule to toggle enabled state', async () => {
    mockGetSchedules.mockResolvedValue({ schedules: [makeSchedule()] });
    mockUpdateSchedule.mockResolvedValue({ schedule: makeSchedule({ enabled: false }) });
    render(<SchedulesPage />);
    await waitFor(() => expect(screen.getByText('Hourly smoke test')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /pause/i }));
    await waitFor(() => expect(mockUpdateSchedule).toHaveBeenCalledWith('s1', { enabled: false }));
  });

  it('calls deleteSchedule when delete is confirmed', async () => {
    mockGetSchedules.mockResolvedValue({ schedules: [makeSchedule()] });
    mockDeleteSchedule.mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SchedulesPage />);
    await waitFor(() => expect(screen.getByText('Hourly smoke test')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    await waitFor(() => expect(mockDeleteSchedule).toHaveBeenCalledWith('s1'));
  });

  it('does not call deleteSchedule when delete is cancelled', async () => {
    mockGetSchedules.mockResolvedValue({ schedules: [makeSchedule()] });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SchedulesPage />);
    await waitFor(() => expect(screen.getByText('Hourly smoke test')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(mockDeleteSchedule).not.toHaveBeenCalled();
  });
});

describe('SchedulesPage — natural language cron conversion', () => {
  it('converts a phrase to a cron expression and shows a preview', async () => {
    mockConvertCron.mockResolvedValue({ cron: '0 9 * * 1-5', preview: 'Every weekday at 9:00 AM' });
    render(<SchedulesPage />);
    await waitFor(() => expect(screen.getByText(/No schedules yet/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /new schedule/i }));
    fireEvent.change(screen.getByPlaceholderText('every weekday at 9am…'), { target: { value: 'every weekday at 9am' } });
    fireEvent.click(screen.getByRole('button', { name: /convert/i }));

    await waitFor(() => expect(mockConvertCron).toHaveBeenCalledWith('every weekday at 9am'));
    await waitFor(() => expect(screen.getByText(/Every weekday at 9:00 AM/)).toBeInTheDocument());
  });
});
