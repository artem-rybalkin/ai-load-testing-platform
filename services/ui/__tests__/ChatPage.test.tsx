// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';
import ChatPage from '../app/chat/page';
import type { WSEvent } from '@/lib/useResultsSocket';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    Link: ({ to, children, ...props }: { to: string; children: React.ReactNode; [key: string]: unknown }) => (
      <a href={String(to)} {...(props as React.HTMLAttributes<HTMLAnchorElement>)}>{children}</a>
    ),
  };
});

const mockUseResultsSocket = vi.hoisted(() => vi.fn());
vi.mock('@/lib/useResultsSocket', () => ({ useResultsSocket: mockUseResultsSocket }));

vi.mock('@/lib/api', () => ({
  parseChatPrompt: vi.fn(),
  createTest: vi.fn(),
  getResult: vi.fn(),
}));

import { parseChatPrompt, createTest, getResult } from '@/lib/api';
const mockParseChatPrompt = vi.mocked(parseChatPrompt);
const mockCreateTest = vi.mocked(createTest);
const mockGetResult = vi.mocked(getResult);

const sendMessage = async (text: string) => {
  const input = screen.getByPlaceholderText(/describe a test/i);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe('ChatPage', () => {
  it('renders the message input and a send button', () => {
    render(<ChatPage />);
    expect(screen.getByPlaceholderText(/describe a test/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  it('sends a message and renders the assistant reply on needsClarification', async () => {
    mockParseChatPrompt.mockResolvedValue({ status: 'needsClarification', question: 'What URL do you want to test?' });
    render(<ChatPage />);
    await sendMessage('I want to load test something');

    await waitFor(() => expect(mockParseChatPrompt).toHaveBeenCalledWith([
      { role: 'user', content: 'I want to load test something' },
    ]));
    await waitFor(() => expect(screen.getByText('What URL do you want to test?')).toBeInTheDocument());
  });

  it('renders a preview card with Run Test / Keep chatting buttons on a ready response', async () => {
    mockParseChatPrompt.mockResolvedValue({
      status: 'ready',
      config: {
        type: 'backend',
        targetUrl: 'https://api.example.com',
        description: 'Load test the API',
        options: { vus: 50, duration: '2m' },
        thresholds: { p95: 1000 },
      },
    });
    render(<ChatPage />);
    await sendMessage('Load test https://api.example.com with 50 VUs for 2 minutes');

    await waitFor(() => expect(screen.getByText('https://api.example.com')).toBeInTheDocument());
    expect(screen.getByText('backend')).toBeInTheDocument();
    expect(screen.getByText('Load test the API')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run test/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit settings/i })).toBeInTheDocument();
  });

  it('dismisses the preview card when Keep chatting is clicked', async () => {
    mockParseChatPrompt.mockResolvedValue({
      status: 'ready',
      config: {
        type: 'backend',
        targetUrl: 'https://api.example.com',
        description: 'Load test the API',
        options: { vus: 50, duration: '2m' },
      },
    });
    render(<ChatPage />);
    await sendMessage('Load test https://api.example.com');
    await waitFor(() => expect(screen.getByRole('button', { name: /edit settings/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /edit settings/i }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /run test/i })).not.toBeInTheDocument());
  });

  it('renders the redirect message with a working link to /?type=flow on redirectToFlowBuilder', async () => {
    mockParseChatPrompt.mockResolvedValue({
      status: 'redirectToFlowBuilder',
      reason: 'This looks like a multi-step flow (login then checkout) — use the Flow Builder instead.',
    });
    render(<ChatPage />);
    await sendMessage('login then go to checkout and pay');

    await waitFor(() => expect(screen.getByText(/login then checkout/i)).toBeInTheDocument());
    const link = screen.getByRole('link', { name: /open flow builder/i });
    expect(link).toHaveAttribute('href', '/?type=flow');
  });

  it('calls createTest and renders a status bubble when Run Test is clicked', async () => {
    mockParseChatPrompt.mockResolvedValue({
      status: 'ready',
      config: {
        type: 'backend',
        targetUrl: 'https://api.example.com',
        description: 'Load test the API',
        options: { vus: 50, duration: '2m' },
      },
    });
    mockCreateTest.mockResolvedValue({ success: true, test: { id: 'test-abc-123' } });

    render(<ChatPage />);
    await sendMessage('Load test https://api.example.com with 50 VUs for 2 minutes');
    await waitFor(() => expect(screen.getByRole('button', { name: /run test/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /run test/i }));

    await waitFor(() => expect(mockCreateTest).toHaveBeenCalledWith(expect.objectContaining({
      type: 'backend',
      targetUrl: 'https://api.example.com',
      description: 'Load test the API',
      options: { vus: 50, duration: '2m' },
    })));
    await waitFor(() => expect(screen.getByText(/test-abc-123/)).toBeInTheDocument());
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
  });

  it('removes the Run Test button after a successful submission, preventing a duplicate test (regression)', async () => {
    mockParseChatPrompt.mockResolvedValue({
      status: 'ready',
      config: {
        type: 'backend',
        targetUrl: 'https://api.example.com',
        description: 'Load test the API',
        options: { vus: 50, duration: '2m' },
      },
    });
    mockCreateTest.mockResolvedValue({ success: true, test: { id: 'test-abc-123' } });

    render(<ChatPage />);
    await sendMessage('Load test https://api.example.com with 50 VUs for 2 minutes');
    await waitFor(() => expect(screen.getByRole('button', { name: /run test/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(mockCreateTest).toHaveBeenCalledTimes(1));

    // The button must be gone (not just disabled) so there's no way to trigger a second createTest call.
    await waitFor(() => expect(screen.queryByRole('button', { name: /run test/i })).not.toBeInTheDocument());
    expect(screen.getByText(/test started/i)).toBeInTheDocument();
    expect(mockCreateTest).toHaveBeenCalledTimes(1);
  });

  it('does not call createTest twice on a rapid double-click (regression)', async () => {
    mockParseChatPrompt.mockResolvedValue({
      status: 'ready',
      config: {
        type: 'backend',
        targetUrl: 'https://api.example.com',
        description: 'Load test the API',
        options: { vus: 50, duration: '2m' },
      },
    });
    let resolveCreateTest: (v: unknown) => void = () => {};
    mockCreateTest.mockReturnValue(new Promise(resolve => { resolveCreateTest = resolve; }));

    render(<ChatPage />);
    await sendMessage('Load test https://api.example.com with 50 VUs for 2 minutes');
    await waitFor(() => expect(screen.getByRole('button', { name: /run test/i })).toBeInTheDocument());

    const button = screen.getByRole('button', { name: /run test/i });
    fireEvent.click(button);
    // Second click before the first createTest() call has resolved — button should already be gone.
    expect(screen.queryByRole('button', { name: /run test/i })).not.toBeInTheDocument();

    resolveCreateTest({ success: true, test: { id: 'test-abc-123' } });
    await waitFor(() => expect(screen.getByText(/test-abc-123/)).toBeInTheDocument());
    expect(mockCreateTest).toHaveBeenCalledTimes(1);
  });

  it('re-enables Run Test if test creation fails, so the user can retry', async () => {
    mockParseChatPrompt.mockResolvedValue({
      status: 'ready',
      config: {
        type: 'backend',
        targetUrl: 'https://api.example.com',
        description: 'Load test the API',
        options: { vus: 50, duration: '2m' },
      },
    });
    mockCreateTest.mockRejectedValueOnce(new Error('quota exceeded'));

    render(<ChatPage />);
    await sendMessage('Load test https://api.example.com with 50 VUs for 2 minutes');
    await waitFor(() => expect(screen.getByRole('button', { name: /run test/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(screen.getByText(/quota exceeded/i)).toBeInTheDocument());

    // Creation failed — no test was actually started, so the button should come back for a retry.
    expect(screen.getByRole('button', { name: /run test/i })).toBeInTheDocument();
  });

  it('updates the status bubble text when a test:status WS event fires for the watched test', async () => {
    mockParseChatPrompt.mockResolvedValue({
      status: 'ready',
      config: {
        type: 'backend',
        targetUrl: 'https://api.example.com',
        description: 'Load test the API',
        options: { vus: 50, duration: '2m' },
      },
    });
    mockCreateTest.mockResolvedValue({ success: true, test: { id: 'test-abc-123' } });

    render(<ChatPage />);
    await sendMessage('Load test https://api.example.com with 50 VUs for 2 minutes');
    await waitFor(() => expect(screen.getByRole('button', { name: /run test/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(screen.getByText(/pending/i)).toBeInTheDocument());

    const onEvent = mockUseResultsSocket.mock.calls[mockUseResultsSocket.mock.calls.length - 1][0] as (e: WSEvent) => void;
    act(() => {
      onEvent({ type: 'test:status', testId: 'test-abc-123', status: 'running' });
    });

    await waitFor(() => expect(screen.getByText(/running/i)).toBeInTheDocument());
  });

  it('renders a flowReady card with step list and action buttons', async () => {
    mockParseChatPrompt.mockResolvedValue({
      status: 'flowReady',
      flow: {
        steps: [
          { name: 'Register', url: 'http://localhost:8080/api/auth/register', method: 'POST', body: '{"username":"test"}' },
          { name: 'Login',    url: 'http://localhost:8080/api/auth/login',    method: 'POST' },
          { name: 'Logout',   url: 'http://localhost:8080/api/auth/logout',   method: 'POST' },
        ],
        targetUrl: 'http://localhost:8080',
        description: 'Register then login then logout',
        options: { vus: 2, duration: '5m', profile: 'load' },
      },
    });
    render(<ChatPage />);
    await sendMessage('create a flow: register then login then logout, 2 VUs 5 min');

    await waitFor(() => expect(screen.getByText('Register')).toBeInTheDocument());
    expect(screen.getByText('Login')).toBeInTheDocument();
    expect(screen.getByText('Logout')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run flow test/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit in flow builder/i })).toBeInTheDocument();
  });

  it('stores full flow config in sessionStorage and navigates when Edit in Flow Builder is clicked', async () => {
    sessionStorage.clear();
    const flow = {
      steps: [
        { name: 'Register', url: 'http://localhost:8080/api/auth/register', method: 'POST' as const },
        { name: 'Login',    url: 'http://localhost:8080/api/auth/login',    method: 'POST' as const },
      ],
      targetUrl: 'http://localhost:8080',
      description: 'Register then login',
      options: { vus: 3, duration: '2m', profile: 'load' as const },
      thresholds: { p95: 500 },
    };
    mockParseChatPrompt.mockResolvedValue({ status: 'flowReady', flow });
    render(<ChatPage />);
    await sendMessage('register then login, 3 users 2 min');

    await waitFor(() => screen.getByRole('button', { name: /edit in flow builder/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit in flow builder/i }));

    const stored = sessionStorage.getItem('chatFlowConfig');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.options.vus).toBe(3);
    expect(parsed.options.duration).toBe('2m');
    expect(parsed.description).toBe('Register then login');
    expect(parsed.thresholds).toEqual({ p95: 500 });
    expect(mockNavigate).toHaveBeenCalledWith('/?type=flow&fromChat=1');
  });

  it('calls createTest with type:flow and steps when Run flow test is clicked', async () => {
    const flow = {
      steps: [
        { name: 'Register', url: 'http://localhost:8080/api/auth/register', method: 'POST' as const },
        { name: 'Login',    url: 'http://localhost:8080/api/auth/login',    method: 'POST' as const },
      ],
      targetUrl: 'http://localhost:8080',
      description: 'Register then login',
      options: { vus: 2, duration: '5m' },
    };
    mockParseChatPrompt.mockResolvedValue({ status: 'flowReady', flow });
    mockCreateTest.mockResolvedValue({ success: true, test: { id: 'flow-test-1' } });
    render(<ChatPage />);
    await sendMessage('register then login, 2 users 5 min');

    await waitFor(() => screen.getByRole('button', { name: /run flow test/i }));
    fireEvent.click(screen.getByRole('button', { name: /run flow test/i }));

    await waitFor(() => expect(mockCreateTest).toHaveBeenCalledWith(expect.objectContaining({
      type: 'flow',
      steps: flow.steps,
      targetUrl: flow.targetUrl,
    })));
  });

  it('triggers a one-shot getResult re-fetch on a reconnected WS event, not polling', async () => {
    mockParseChatPrompt.mockResolvedValue({
      status: 'ready',
      config: {
        type: 'backend',
        targetUrl: 'https://api.example.com',
        description: 'Load test the API',
        options: { vus: 50, duration: '2m' },
      },
    });
    mockCreateTest.mockResolvedValue({ success: true, test: { id: 'test-abc-123' } });
    mockGetResult.mockResolvedValue({ result: { status: 'completed' } } as never);

    render(<ChatPage />);
    await sendMessage('Load test https://api.example.com with 50 VUs for 2 minutes');
    await waitFor(() => expect(screen.getByRole('button', { name: /run test/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(screen.getByText(/pending/i)).toBeInTheDocument());

    const onEvent = mockUseResultsSocket.mock.calls[mockUseResultsSocket.mock.calls.length - 1][0] as (e: WSEvent) => void;

    expect(mockGetResult).not.toHaveBeenCalled();
    await act(async () => {
      onEvent({ type: 'reconnected' });
    });

    await waitFor(() => expect(mockGetResult).toHaveBeenCalledWith('test-abc-123'));
    expect(mockGetResult).toHaveBeenCalledTimes(1);

    // Firing a second reconnected event should fetch again (once per event), not start a poll loop.
    await act(async () => {
      onEvent({ type: 'reconnected' });
    });
    await waitFor(() => expect(mockGetResult).toHaveBeenCalledTimes(2));
  });
});
