/** @jest-environment node */
jest.mock('../database', () => ({ initDB: jest.fn(), getSystemSetting: jest.fn() }));
import { isPlaceholderOpenAi } from './llm.service';

test('only the real OpenAI host with the placeholder key counts as not set up', () => {
  expect(isPlaceholderOpenAi('https://api.openai.com/v1', 'dummy-key')).toBe(true);
  expect(isPlaceholderOpenAi('https://api.openai.com.example.net/v1', 'dummy-key')).toBe(false);
  expect(isPlaceholderOpenAi('https://example.net/api.openai.com/v1', 'dummy-key')).toBe(false);
  expect(isPlaceholderOpenAi('https://api.openai.com/v1', 'sk-real')).toBe(false);
  expect(isPlaceholderOpenAi('not a url', 'dummy-key')).toBe(false);
});
