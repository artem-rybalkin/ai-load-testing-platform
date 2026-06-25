// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import LibraryPage from '../app/library/page';
import { SCRIPT_TEMPLATES } from '../lib/scriptTemplates';

const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('LibraryPage', () => {
  it('renders all built-in script templates with name and tags', () => {
    render(<LibraryPage />);
    for (const t of SCRIPT_TEMPLATES) {
      expect(screen.getByText(t.name)).toBeInTheDocument();
    }
  });

  it('hides the script preview until "Preview" is clicked', () => {
    render(<LibraryPage />);
    const first = SCRIPT_TEMPLATES[0];
    expect(screen.queryByText(new RegExp(first.script.split('\n')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: /preview/i })[0]);
    expect(screen.getByText(new RegExp(first.script.split('\n')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /hide preview/i }));
    expect(screen.queryByText(new RegExp(first.script.split('\n')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).not.toBeInTheDocument();
  });

  it('navigates to the home page with the template id when "Use template" is clicked', () => {
    render(<LibraryPage />);
    const first = SCRIPT_TEMPLATES[0];
    fireEvent.click(screen.getAllByRole('button', { name: /use template/i })[0]);
    expect(mockNavigate).toHaveBeenCalledWith(`/?useScriptTemplate=${first.id}`);
  });
});
