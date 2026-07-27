// jsdom's sandboxed globals don't expose TextEncoder/TextDecoder, but some
// dependencies use them at module load — e.g. content-disposition (pulled via
// express) constructs `new TextDecoder('utf-8')` on import. Node provides both
// as globals at runtime; polyfill them here so jsdom-hosted suites can import
// server code without throwing.
const { TextEncoder, TextDecoder } = require('util');
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;
