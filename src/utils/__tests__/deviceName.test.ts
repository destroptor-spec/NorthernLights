import { isPhoneOrTablet } from '../deviceName';

const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  linuxChrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
};

test('phones and tablets, where the system routes audio', () => {
  expect(isPhoneOrTablet(UA.androidChrome, 5)).toBe(true);
  expect(isPhoneOrTablet(UA.iphone, 5)).toBe(true);
  // iPadOS asks for desktop pages: a "Mac" with a touch screen.
  expect(isPhoneOrTablet(UA.macSafari, 5)).toBe(true);
});

test('computers, where a page can choose an output', () => {
  expect(isPhoneOrTablet(UA.macSafari, 0)).toBe(false);
  expect(isPhoneOrTablet(UA.linuxChrome, 0)).toBe(false);
  expect(isPhoneOrTablet(UA.windowsFirefox, 0)).toBe(false);
});
