// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RecordingSession } from '@/lib/api';

// ── Mocks ─────────────────────────────────────────────────────────────────────
// vi.hoisted ensures these are defined when vi.mock factory runs (mock hoisting)

const mockStartRecording = vi.hoisted(() => vi.fn());
const mockStopRecording  = vi.hoisted(() => vi.fn());
const mockGetRecording   = vi.hoisted(() => vi.fn());
const mockWindowOpen     = vi.hoisted(() => vi.fn());
const mockAlert          = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  startRecording: mockStartRecording,
  stopRecording:  mockStopRecording,
  getRecording:   mockGetRecording,
  RECORDER_URL:   'http://localhost:3007',
  // Not used by FlowBuilder directly but imported
  FlowStep: undefined,
  ExtractRule: undefined,
  ExtractSource: undefined,
  RecordingSession: undefined,
}));

// React Router is used by the page layout but not FlowBuilder directly
vi.mock('react-router-dom', () => ({
  Link: ({ to, children, ...p }: { to: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={String(to)} {...(p as React.HTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/' }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

import FlowBuilder from '../app/components/FlowBuilder';
afterEach(() => cleanup());

// ── Default props ─────────────────────────────────────────────────────────────

const defaultProps = {
  steps: [],
  envVars: [],
  onChange: vi.fn(),
  onEnvVarsChange: vi.fn(),
  testData: [],
  onTestDataChange: vi.fn(),
  csvFile: null,
  onCsvChange: vi.fn(),
};

const makeSession = (overrides: Partial<RecordingSession> = {}): RecordingSession => ({
  id: 'session-123',
  status: 'active',
  noVncUrl: 'http://localhost:6080/vnc.html?autoconnect=true',
  stepCount: 0,
  ...overrides,
});

const makeFlowStep = (name: string) => ({
  name,
  url: `https://example.com/${name}`,
  method: 'GET' as const,
});

const makeHarEntry = (overrides: {
  url?: string;
  method?: string;
  mimeType?: string;
  postDataText?: string;
  headers?: Array<{ name: string; value: string }>;
} = {}) => ({
  request: {
    url: overrides.url ?? 'https://api.example.com/users',
    method: overrides.method ?? 'GET',
    ...(overrides.postDataText !== undefined ? { postData: { text: overrides.postDataText } } : {}),
    headers: overrides.headers ?? [{ name: 'Accept', value: 'application/json' }],
  },
  response: { content: { mimeType: overrides.mimeType ?? 'application/json' } },
});

const makeHar = (entries: unknown[]) => JSON.stringify({ log: { entries } });

const getHarInput = (container: HTMLElement) =>
  container.querySelector('input[type="file"][accept*="har"]') as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('open', mockWindowOpen);
  vi.stubGlobal('alert', mockAlert);
  mockGetRecording.mockResolvedValue(makeSession());
});

// ─── Initial render ───────────────────────────────────────────────────────────

describe('FlowBuilder — initial state', () => {
  it('renders Record button', () => {
    render(<FlowBuilder {...defaultProps} />);
    expect(screen.getByRole('button', { name: /record/i })).toBeInTheDocument();
  });

  it('does not show recording panel when idle', () => {
    render(<FlowBuilder {...defaultProps} />);
    expect(screen.queryByText(/recording in progress/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/stop recording/i)).not.toBeInTheDocument();
  });
});

// ─── Starting a recording ─────────────────────────────────────────────────────

describe('FlowBuilder — starting a recording', () => {
  it('shows Launching state immediately after clicking Record', async () => {
    let resolveStart!: (v: RecordingSession) => void;
    mockStartRecording.mockReturnValue(new Promise(r => { resolveStart = r; }));

    render(<FlowBuilder {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /record/i }));

    expect(screen.getByRole('button', { name: /launching/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /launching/i })).toBeDisabled();

    // Resolve so component doesn't stay in pending state
    await act(async () => { resolveStart(makeSession()); });
  });

  it('shows info panel with host.docker.internal hint while launching', async () => {
    let resolveStart!: (v: RecordingSession) => void;
    mockStartRecording.mockReturnValue(new Promise(r => { resolveStart = r; }));

    render(<FlowBuilder {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /record/i }));

    expect(screen.getByText(/host\.docker\.internal/i)).toBeInTheDocument();

    await act(async () => { resolveStart(makeSession()); });
  });

  it('opens the viewer tab and registers __recordingDone after successful start', async () => {
    mockStartRecording.mockResolvedValue(makeSession());
    render(<FlowBuilder {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /record/i }));
    });

    expect(mockWindowOpen).toHaveBeenCalledWith(
      expect.stringContaining('/viewer/session-123'),
      '_blank',
    );
    expect(typeof (window as any).__recordingDone).toBe('function');
  });

  it('shows error banner when startRecording throws', async () => {
    mockStartRecording.mockRejectedValue(new Error('recorder unreachable'));
    render(<FlowBuilder {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /record/i }));
    });

    expect(screen.getByText(/recorder unreachable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /record/i })).not.toBeDisabled();
  });
});

// ─── Active recording ─────────────────────────────────────────────────────────

describe('FlowBuilder — active recording panel', () => {
  const startRecording = async () => {
    mockStartRecording.mockResolvedValue(makeSession());
    render(<FlowBuilder {...defaultProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /record/i }));
    });
  };

  it('shows recording panel with step count after start', async () => {
    await startRecording();

    expect(screen.getByText(/recording —/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop recording/i })).toBeInTheDocument();
  });

  it('shows updated step count from polling', async () => {
    mockGetRecording.mockResolvedValue(makeSession({ stepCount: 3 }));
    await startRecording();

    await waitFor(() => {
      expect(screen.getByText(/3 request/i)).toBeInTheDocument();
    }, { timeout: 2000 });
  });

  it('Record button becomes Stop Recording during active session', async () => {
    await startRecording();

    const stopBtn = screen.getByRole('button', { name: /stop recording/i });
    expect(stopBtn).toBeInTheDocument();
    expect(stopBtn).not.toBeDisabled();
  });
});

// ─── Stopping from FlowBuilder ────────────────────────────────────────────────

describe('FlowBuilder — stopping recording from FlowBuilder', () => {
  const startAndGetStopBtn = async () => {
    mockStartRecording.mockResolvedValue(makeSession());
    render(<FlowBuilder {...defaultProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /record/i }));
    });
    return screen.getByRole('button', { name: /stop recording/i });
  };

  it('calls stopRecording when Stop button is clicked', async () => {
    const steps = [makeFlowStep('login')];
    mockStopRecording.mockResolvedValue({ ...makeSession(), status: 'completed', steps, stepCount: 1 });

    const btn = await startAndGetStopBtn();
    await act(async () => { fireEvent.click(btn); });

    expect(mockStopRecording).toHaveBeenCalledWith('session-123');
  });

  it('imports steps via onChange when stop succeeds', async () => {
    const steps = [makeFlowStep('login'), makeFlowStep('dashboard')];
    mockStopRecording.mockResolvedValue({ ...makeSession(), status: 'completed', steps, stepCount: 2 });

    const btn = await startAndGetStopBtn();
    await act(async () => { fireEvent.click(btn); });

    expect(defaultProps.onChange).toHaveBeenCalledWith(steps);
  });

  it('clears recording state after stop', async () => {
    mockStopRecording.mockResolvedValue({ ...makeSession(), status: 'completed', steps: [], stepCount: 0 });

    const btn = await startAndGetStopBtn();
    await act(async () => { fireEvent.click(btn); });

    expect(screen.queryByRole('button', { name: /stop recording/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /record/i })).toBeInTheDocument();
  });

  it('treats 404 on stop as clean exit (session already ended)', async () => {
    mockStopRecording.mockRejectedValue(new Error('Recorder error: 404'));

    const btn = await startAndGetStopBtn();
    await act(async () => { fireEvent.click(btn); });

    // No error shown, recording cleared
    expect(screen.queryByText(/failed to stop/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /record/i })).toBeInTheDocument();
  });

  it('shows error and reverts to active when stop fails with non-404', async () => {
    mockStopRecording.mockRejectedValue(new Error('network error'));

    const btn = await startAndGetStopBtn();
    await act(async () => { fireEvent.click(btn); });

    expect(screen.getByText(/network error/i)).toBeInTheDocument();
    // Recording still shows
    expect(screen.getByRole('button', { name: /stop recording/i })).toBeInTheDocument();
  });
});

// ─── Cancel button while stopping ────────────────────────────────────────────

describe('FlowBuilder — cancel button during processing', () => {
  it('shows Cancel button while stop is in flight (stopping state)', async () => {
    mockStartRecording.mockResolvedValue(makeSession());
    // stopRecording never resolves — simulates long AI correlation
    mockStopRecording.mockReturnValue(new Promise(() => {}));

    render(<FlowBuilder {...defaultProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /record/i }));
    });

    fireEvent.click(screen.getByRole('button', { name: /stop recording/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });
  });

  it('clicking Cancel immediately clears recording state', async () => {
    mockStartRecording.mockResolvedValue(makeSession());
    mockStopRecording.mockReturnValue(new Promise(() => {}));

    render(<FlowBuilder {...defaultProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /record/i }));
    });

    fireEvent.click(screen.getByRole('button', { name: /stop recording/i }));
    await waitFor(() => screen.getByRole('button', { name: /cancel/i }));

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.getByRole('button', { name: /record/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
  });
});

// ─── __recordingDone callback (steps pushed from viewer tab) ─────────────────

describe('FlowBuilder — __recordingDone callback from viewer tab', () => {
  const startRecordingAndGetCallback = async () => {
    mockStartRecording.mockResolvedValue(makeSession());
    render(<FlowBuilder {...defaultProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /record/i }));
    });
    return (window as any).__recordingDone as (steps: unknown[]) => void;
  };

  it('imports steps when viewer tab calls __recordingDone with steps', async () => {
    const callback = await startRecordingAndGetCallback();
    const steps = [makeFlowStep('home'), makeFlowStep('login')];

    await act(async () => { callback(steps); });

    expect(defaultProps.onChange).toHaveBeenCalledWith(steps);
  });

  it('clears recording state after __recordingDone is called', async () => {
    const callback = await startRecordingAndGetCallback();

    await act(async () => { callback([]); });

    expect(screen.getByRole('button', { name: /record/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /stop recording/i })).not.toBeInTheDocument();
  });

  it('cleans up __recordingDone from window after it fires', async () => {
    const callback = await startRecordingAndGetCallback();

    await act(async () => { callback([]); });

    expect((window as any).__recordingDone).toBeUndefined();
  });

  it('does not call onChange when steps array is empty', async () => {
    const callback = await startRecordingAndGetCallback();

    await act(async () => { callback([]); });

    expect(defaultProps.onChange).not.toHaveBeenCalled();
  });
});

// ─── Polling detects external stop ───────────────────────────────────────────

describe('FlowBuilder — polling detects session completed externally', () => {
  it('imports steps when poll returns completed status with steps', async () => {
    const steps = [makeFlowStep('api-call')];
    mockStartRecording.mockResolvedValue(makeSession());
    // First poll: active; subsequent: completed with steps
    mockGetRecording
      .mockResolvedValueOnce(makeSession({ stepCount: 1 }))
      .mockResolvedValue(makeSession({ status: 'completed', steps, stepCount: 1 }));

    render(<FlowBuilder {...defaultProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /record/i }));
    });

    await waitFor(() => {
      expect(defaultProps.onChange).toHaveBeenCalledWith(steps);
    }, { timeout: 3000 });
  });

  it('clears recording state when poll returns 404 (session expired)', async () => {
    mockStartRecording.mockResolvedValue(makeSession());
    mockGetRecording.mockRejectedValue(new Error('Recorder error: 404'));

    render(<FlowBuilder {...defaultProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /record/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /record/i })).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('does NOT propagate server-side stopping status (keeps polling alive)', async () => {
    // Server returns 'stopping' while it processes AI correlation.
    // The FlowBuilder must keep recording.status = 'active' so the poll interval is not killed.
    mockStartRecording.mockResolvedValue(makeSession());
    mockGetRecording
      .mockResolvedValueOnce(makeSession({ status: 'stopping', stepCount: 3 }))
      .mockResolvedValue(makeSession({ status: 'active', stepCount: 3 }));

    render(<FlowBuilder {...defaultProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /record/i }));
    });

    // Even after a 'stopping' poll response, Stop Recording button must remain visible
    // (recording not cleared, poll not stopped)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /stop recording/i })).toBeInTheDocument();
    }, { timeout: 2000 });
  });
});

// ─── visibilitychange handler ─────────────────────────────────────────────────

describe('FlowBuilder — visibilitychange tab-switch detection', () => {
  const startAndSimulateBackground = async () => {
    mockStartRecording.mockResolvedValue(makeSession());
    render(<FlowBuilder {...defaultProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /record/i }));
    });
    // Simulate tab going to background (browser throttles setInterval)
    Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true });
  };

  const simulateTabFocus = () => {
    Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  afterEach(() => {
    Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true });
  });

  it('immediately polls when tab becomes visible again', async () => {
    const steps = [makeFlowStep('checkout')];
    mockGetRecording.mockResolvedValue(makeSession({ status: 'completed', steps, stepCount: 1 }));
    await startAndSimulateBackground();

    await act(async () => { simulateTabFocus(); });

    await waitFor(() => {
      expect(defaultProps.onChange).toHaveBeenCalledWith(steps);
    }, { timeout: 2000 });
  });

  it('clears recording and imports steps when tab becomes visible after external stop', async () => {
    const steps = [makeFlowStep('login'), makeFlowStep('home')];
    mockGetRecording.mockResolvedValue(makeSession({ status: 'completed', steps, stepCount: 2 }));
    await startAndSimulateBackground();

    await act(async () => { simulateTabFocus(); });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /record/i })).toBeInTheDocument();
    }, { timeout: 2000 });
    expect(defaultProps.onChange).toHaveBeenCalledWith(steps);
  });

  it('does nothing when tab becomes visible but recording is not active', async () => {
    // No recording started — visibilitychange should be a no-op
    render(<FlowBuilder {...defaultProps} />);
    Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true });
    Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    await new Promise(r => setTimeout(r, 100));
    expect(mockGetRecording).not.toHaveBeenCalled();
  });
});

// ─── Import from HAR ─────────────────────────────────────────────────────────

describe('FlowBuilder — Import from HAR', () => {
  it('clicking "Import from HAR" triggers the hidden file input', () => {
    const { container } = render(<FlowBuilder {...defaultProps} />);
    const input = getHarInput(container);
    const clickSpy = vi.spyOn(input, 'click');

    fireEvent.click(screen.getByRole('button', { name: /import from har/i }));

    expect(clickSpy).toHaveBeenCalled();
  });

  it('imports filtered API requests and maps them to FlowSteps', async () => {
    const har = makeHar([
      makeHarEntry({ url: 'https://api.example.com/users', method: 'GET' }),
      makeHarEntry({ url: 'https://api.example.com/orders', method: 'POST', postDataText: '{"id":1}' }),
      makeHarEntry({ url: 'https://example.com/app.js', method: 'GET', mimeType: 'application/javascript' }),
    ]);
    const file = new File([har], 'recording.har', { type: 'application/json' });
    const { container } = render(<FlowBuilder {...defaultProps} />);

    await act(async () => { await userEvent.upload(getHarInput(container), file); });

    await waitFor(() => expect(defaultProps.onChange).toHaveBeenCalled());
    const imported = defaultProps.onChange.mock.calls[0][0];
    expect(imported).toHaveLength(2);
    expect(imported[0]).toMatchObject({
      name: 'Step 1: GET /users',
      url: 'https://api.example.com/users',
      method: 'GET',
      body: '',
    });
    expect(imported[1]).toMatchObject({
      name: 'Step 2: POST /orders',
      url: 'https://api.example.com/orders',
      method: 'POST',
      body: '{"id":1}',
    });
  });

  it('strips sensitive headers (cookie, authorization, host, content-length, connection)', async () => {
    const har = makeHar([
      makeHarEntry({
        url: 'https://api.example.com/me',
        method: 'GET',
        headers: [
          { name: 'Cookie', value: 'session=abc' },
          { name: 'Authorization', value: 'Bearer xyz' },
          { name: 'Host', value: 'api.example.com' },
          { name: 'Content-Length', value: '0' },
          { name: 'Connection', value: 'keep-alive' },
          { name: 'Accept', value: 'application/json' },
        ],
      }),
    ]);
    const file = new File([har], 'recording.har', { type: 'application/json' });
    const { container } = render(<FlowBuilder {...defaultProps} />);

    await act(async () => { await userEvent.upload(getHarInput(container), file); });

    await waitFor(() => expect(defaultProps.onChange).toHaveBeenCalled());
    const [step] = defaultProps.onChange.mock.calls[0][0];
    expect(step.headers).toEqual({ Accept: 'application/json' });
  });

  it('shows a filtered-entries note when static assets were excluded', async () => {
    const har = makeHar([
      makeHarEntry({ url: 'https://api.example.com/users', method: 'GET' }),
      makeHarEntry({ url: 'https://example.com/app.js', method: 'GET', mimeType: 'application/javascript' }),
      makeHarEntry({ url: 'https://example.com/style.css', method: 'GET', mimeType: 'text/css' }),
    ]);
    const file = new File([har], 'recording.har', { type: 'application/json' });
    const { container } = render(<FlowBuilder {...defaultProps} />);

    await act(async () => { await userEvent.upload(getHarInput(container), file); });

    await waitFor(() => {
      expect(screen.getByText(/1 of 3 HAR entries imported/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/static assets.*were filtered out/i)).toBeInTheDocument();
  });

  it('does not show a filtered-entries note when nothing was filtered', async () => {
    const har = makeHar([
      makeHarEntry({ url: 'https://api.example.com/users', method: 'GET' }),
      makeHarEntry({ url: 'https://api.example.com/orders', method: 'POST' }),
    ]);
    const file = new File([har], 'recording.har', { type: 'application/json' });
    const { container } = render(<FlowBuilder {...defaultProps} />);

    await act(async () => { await userEvent.upload(getHarInput(container), file); });

    await waitFor(() => expect(defaultProps.onChange).toHaveBeenCalled());
    expect(screen.queryByText(/HAR entries imported/i)).not.toBeInTheDocument();
  });

  it('alerts and skips onChange when no XHR/API requests are found', async () => {
    const har = makeHar([
      makeHarEntry({ url: 'https://example.com/app.js', method: 'GET', mimeType: 'application/javascript' }),
      makeHarEntry({ url: 'ws://example.com/socket', method: 'GET' }),
    ]);
    const file = new File([har], 'recording.har', { type: 'application/json' });
    const { container } = render(<FlowBuilder {...defaultProps} />);

    await act(async () => { await userEvent.upload(getHarInput(container), file); });

    await waitFor(() => {
      expect(mockAlert).toHaveBeenCalledWith(expect.stringMatching(/No XHR\/API requests found in HAR file/i));
    });
    expect(defaultProps.onChange).not.toHaveBeenCalled();
  });

  it('alerts gracefully when the uploaded file is not valid HAR/JSON', async () => {
    const file = new File(['not valid json{{{'], 'broken.har', { type: 'application/json' });
    const { container } = render(<FlowBuilder {...defaultProps} />);

    await act(async () => { await userEvent.upload(getHarInput(container), file); });

    await waitFor(() => {
      expect(mockAlert).toHaveBeenCalledWith(expect.stringMatching(/No XHR\/API requests found in HAR file/i));
    });
    expect(defaultProps.onChange).not.toHaveBeenCalled();
  });

  it('caps imports at the first 50 matching entries', async () => {
    const entries = Array.from({ length: 60 }, (_, i) =>
      makeHarEntry({ url: `https://api.example.com/item/${i}`, method: 'GET' })
    );
    const file = new File([makeHar(entries)], 'recording.har', { type: 'application/json' });
    const { container } = render(<FlowBuilder {...defaultProps} />);

    await act(async () => { await userEvent.upload(getHarInput(container), file); });

    await waitFor(() => expect(defaultProps.onChange).toHaveBeenCalled());
    const imported = defaultProps.onChange.mock.calls[0][0];
    expect(imported).toHaveLength(50);
    expect(screen.getByText(/50 of 60 HAR entries imported/i)).toBeInTheDocument();
  });

  it('resets the file input value after processing so the same file can be re-imported', async () => {
    const file = new File(
      [makeHar([makeHarEntry({ url: 'https://api.example.com/users', method: 'GET' })])],
      'recording.har',
      { type: 'application/json' },
    );
    const { container } = render(<FlowBuilder {...defaultProps} />);
    const input = getHarInput(container);

    await act(async () => { await userEvent.upload(input, file); });

    await waitFor(() => expect(defaultProps.onChange).toHaveBeenCalled());
    expect(input.value).toBe('');
  });
});
