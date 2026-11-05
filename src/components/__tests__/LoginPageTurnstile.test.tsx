import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LoginPage } from '../LoginPage';

/**
 * Prod 2026-10-29: a new user could never sign in. Every attempt reached the
 * server without a Turnstile token (`captcha_missing`), because Sign in was
 * enabled before the challenge finished, and each failure reset the widget so
 * the wait started over. Sign in now waits for the token.
 */

jest.mock('../SoftAurora', () => () => null);
jest.mock('../../hooks/useAuthConfig', () => ({
  useAuthConfig: () => ({ turnstileEnabled: true, turnstileSiteKey: 'site-key', loading: false }),
}));

let issueToken: ((token: string) => void) | null = null;
let failWidget: (() => void) | null = null;
const loadScript = jest.fn(() => Promise.resolve());
jest.mock('../../utils/turnstile', () => ({
  loadTurnstileScript: () => loadScript(),
  renderTurnstileWidget: (_el: HTMLElement, _key: string, handlers: { onToken: (t: string) => void; onError: () => void }) => {
    issueToken = handlers.onToken;
    failWidget = handlers.onError;
    return 'widget-1';
  },
  resetTurnstileWidget: jest.fn(),
  removeTurnstileWidget: jest.fn(),
}));

beforeEach(() => {
  issueToken = null;
  failWidget = null;
  loadScript.mockReset();
  loadScript.mockImplementation(() => Promise.resolve());
});

async function reachPasswordStep(onLogin = jest.fn().mockResolvedValue({ success: true })) {
  render(<LoginPage onLogin={onLogin} />);
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'D0Tch' } });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  fireEvent.change(document.getElementById('login-password')!, { target: { value: 'secret-password' } });
  await waitFor(() => expect(issueToken).not.toBeNull());
  return onLogin;
}

const signIn = () => screen.getByRole('button', { name: /sign in/i }) as HTMLButtonElement;

test('Sign in waits for the captcha token, then sends it', async () => {
  const onLogin = await reachPasswordStep();
  expect(signIn().disabled).toBe(true);

  act(() => issueToken!('turnstile-token'));
  expect(signIn().disabled).toBe(false);
  fireEvent.click(signIn());
  await waitFor(() => expect(onLogin).toHaveBeenCalledWith('D0Tch', 'secret-password', true, 'turnstile-token'));
});

test('after a failed attempt Sign in waits for a fresh token', async () => {
  const onLogin = await reachPasswordStep(jest.fn().mockResolvedValue({ success: false, error: 'Invalid credentials' }));
  act(() => issueToken!('first-token'));
  fireEvent.click(signIn());
  await waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(signIn().disabled).toBe(true));

  act(() => issueToken!('second-token'));
  expect(signIn().disabled).toBe(false);
});

test('a widget error offers Try again, which restarts the challenge', async () => {
  await reachPasswordStep();
  act(() => failWidget!());
  expect(screen.queryByText("Verification didn't complete.")).not.toBeNull();
  expect(signIn().disabled).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.queryByText("Verification didn't complete.")).toBeNull();
  act(() => issueToken!('token-after-retry'));
  expect(signIn().disabled).toBe(false);
});

test('Try again loads the script again when it failed to load', async () => {
  loadScript.mockImplementationOnce(() => Promise.reject(new Error('blocked')));
  render(<LoginPage onLogin={jest.fn()} />);
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'D0Tch' } });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  await screen.findByText("Verification didn't complete.");
  expect(issueToken).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(issueToken).not.toBeNull());
  expect(loadScript).toHaveBeenCalledTimes(2);
});

test('the username field turns off auto-capitals and autocorrect', () => {
  render(<LoginPage onLogin={jest.fn()} />);
  const input = screen.getByLabelText('Username');
  expect(input.getAttribute('autocapitalize')).toBe('none');
  expect(input.getAttribute('autocorrect')).toBe('off');
  expect(input.getAttribute('spellcheck')).toBe('false');
});
